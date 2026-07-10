import os
import json
import base64
import re
import email.utils
import sqlite3
import threading
import time
import secrets
from datetime import datetime
from flask import Flask, jsonify, render_template, request, send_from_directory
from google.auth.transport.requests import Request
from google.oauth2.credentials import Credentials
from google_auth_oauthlib.flow import InstalledAppFlow
from googleapiclient.discovery import build

app = Flask(__name__)
API_TOKEN = secrets.token_hex(16)

@app.before_request
def verify_api_token():
    if request.path.startswith('/api/'):
        if request.method == 'OPTIONS':
            return
        token = request.headers.get('X-API-Token')
        if not token or token != API_TOKEN:
            return jsonify({'error': 'Unauthorized: Invalid API Token'}), 403

@app.after_request
def add_header(response):
    response.headers["Cache-Control"] = "no-cache, no-store, must-revalidate"
    response.headers["Pragma"] = "no-cache"
    response.headers["Expires"] = "0"
    return response

DATABASE = 'gmail_cache.db'
SCOPES = [
    'https://www.googleapis.com/auth/gmail.readonly',
    'https://www.googleapis.com/auth/gmail.modify'
]

# Global Sync Status Tracking
sync_info = {
    'status': 'idle', # 'idle', 'syncing', 'completed', 'failed'
    'total_cached': 0,
    'new_messages_fetched': 0,
    'current_page': 0,
    'error': None
}

def get_db_connection():
    conn = sqlite3.connect(get_db_path())
    conn.row_factory = sqlite3.Row
    # Enable WAL mode for concurrency between background thread and Flask requests
    conn.execute('PRAGMA journal_mode=WAL;')
    return conn

def init_db():
    # Migrate legacy database if present
    if os.path.exists('gmail_cache.db'):
        active_email = get_active_profile()
        if active_email:
            sanitized = re.sub(r'[^a-zA-Z0-9@.]', '_', active_email)
            target_db = f"gmail_cache_{sanitized}.db"
            if not os.path.exists(target_db):
                try:
                    os.rename('gmail_cache.db', target_db)
                    print(f"Migrated legacy database to {target_db}")
                    if os.path.exists('gmail_cache.db-wal'):
                        try: os.rename('gmail_cache.db-wal', f"{target_db}-wal")
                        except Exception: pass
                    if os.path.exists('gmail_cache.db-shm'):
                        try: os.rename('gmail_cache.db-shm', f"{target_db}-shm")
                        except Exception: pass
                except Exception as db_err:
                    print(f"Error migrating legacy database: {db_err}")

    conn = get_db_connection()
    conn.execute('''
        CREATE TABLE IF NOT EXISTS messages (
            id TEXT PRIMARY KEY,
            thread_id TEXT,
            sender_name TEXT,
            sender_email TEXT,
            subject TEXT,
            date TEXT,
            timestamp REAL,
            snippet TEXT,
            category TEXT,
            unread INTEGER,
            body TEXT
        )
    ''')
    try:
        conn.execute('ALTER TABLE messages ADD COLUMN unsubscribe_link TEXT;')
        conn.commit()
    except sqlite3.OperationalError:
        # Column already exists
        pass
    try:
        conn.execute('ALTER TABLE messages ADD COLUMN local_only INTEGER DEFAULT 0;')
        conn.commit()
    except sqlite3.OperationalError:
        # Column already exists
        pass
    conn.execute('''
        CREATE TABLE IF NOT EXISTS sync_state (
            key TEXT PRIMARY KEY,
            value TEXT
        )
    ''')
    conn.execute('''
        CREATE TABLE IF NOT EXISTS unsubscribed_senders (
            sender_email TEXT PRIMARY KEY,
            unsubscribed_at REAL
        )
    ''')
    try:
        conn.execute('ALTER TABLE unsubscribed_senders ADD COLUMN status TEXT;')
        conn.commit()
    except sqlite3.OperationalError:
        pass
    conn.execute('''
        CREATE TABLE IF NOT EXISTS delete_queue (
            sender_email TEXT PRIMARY KEY,
            queued_at REAL,
            status TEXT DEFAULT 'pending',
            total_emails INTEGER DEFAULT 0
        )
    ''')
    try:
        conn.execute('ALTER TABLE delete_queue ADD COLUMN total_emails INTEGER DEFAULT 0;')
    except sqlite3.OperationalError:
        pass
    conn.commit()
    conn.close()

def set_active_profile(email):
    try:
        with open('settings.json', 'w') as f:
            json.dump({'active_profile': email}, f)
    except Exception as e:
        print(f"Error setting active profile: {e}")

def get_active_profile():
    if os.path.exists('settings.json'):
        try:
            with open('settings.json', 'r') as f:
                return json.load(f).get('active_profile')
        except Exception:
            pass
    # Fallback to scan directory
    for file in os.listdir('.'):
        if file.startswith('token_') and file.endswith('.json'):
            email = file[6:-5]
            set_active_profile(email)
            return email
    # Backward compatibility
    if os.path.exists('token.json'):
        try:
            creds = Credentials.from_authorized_user_file('token.json', SCOPES)
            service = build('gmail', 'v1', credentials=creds)
            profile = service.users().getProfile(userId='me').execute()
            email = profile.get('emailAddress')
            if email:
                os.rename('token.json', f'token_{email}.json')
                set_active_profile(email)
                return email
        except Exception as e:
            print(f"Failed to migrate legacy token.json: {e}")
            try:
                os.remove('token.json')
            except Exception:
                pass
    return None

def get_db_path():
    email = get_active_profile()
    if email:
        sanitized = re.sub(r'[^a-zA-Z0-9@.]', '_', email)
        return f'gmail_cache_{sanitized}.db'
    return 'gmail_cache_default.db'

def get_gmail_service(run_flow=True):
    active_email = get_active_profile()
    token_path = f"token_{active_email}.json" if active_email else "token_temp.json"
    
    creds = None
    if active_email and os.path.exists(token_path):
        try:
            with open(token_path, 'r') as f:
                token_data = json.load(f)
            token_scopes = token_data.get('scopes', [])
            if not all(scope in token_scopes for scope in SCOPES):
                print(f"Token scopes mismatch for {active_email}. Discarding token...")
                os.remove(token_path)
            else:
                creds = Credentials.from_authorized_user_file(token_path, SCOPES)
        except Exception as e:
            print(f"Error checking token scopes: {e}")
            
    if not creds or not creds.valid:
        if creds and creds.expired and creds.refresh_token:
            print(f"Refreshing token for {active_email}...")
            try:
                creds.refresh(Request())
                with open(token_path, 'w') as token:
                    token.write(creds.to_json())
            except Exception as e:
                print(f"Token refresh failed: {e}")
                creds = None
                
        if not creds or not creds.valid:
            if not run_flow:
                raise Exception("Token expired or missing")
            if not os.path.exists('credentials.json'):
                raise FileNotFoundError("Missing credentials.json")
            
            print("Token is missing or invalid. Triggering OAuth Consent Flow...")
            flow = InstalledAppFlow.from_client_secrets_file('credentials.json', SCOPES)
            creds = flow.run_local_server(port=0, prompt='select_account')
            
            temp_service = build('gmail', 'v1', credentials=creds)
            profile = temp_service.users().getProfile(userId='me').execute()
            new_email = profile.get('emailAddress')
            
            if not new_email:
                raise Exception("Could not fetch user profile details")
                
            actual_token_path = f"token_{new_email}.json"
            with open(actual_token_path, 'w') as token:
                token.write(creds.to_json())
            
            set_active_profile(new_email)
            print(f"Auth flow complete: Linked profile {new_email}")
            return temp_service
                
    return build('gmail', 'v1', credentials=creds)

def parse_date_to_timestamp(date_str):
    try:
        dt = email.utils.parsedate_to_datetime(date_str)
        return dt.timestamp()
    except Exception:
        return 0

def normalize_subject(subject):
    s = subject.lower().strip()
    s = re.sub(r'^(re|fwd|reply|aw|fw|vs):\s*', '', s)
    return s.strip()

def get_email_body(payload):
    body = ""
    html_body = ""
    
    def parse_parts(parts):
        nonlocal body, html_body
        for part in parts:
            mime_type = part.get('mimeType', '')
            part_body = part.get('body', {})
            data = part_body.get('data', '')
            
            if data:
                try:
                    decoded = base64.urlsafe_b64decode(data).decode('utf-8', errors='replace')
                except Exception as e:
                    print(f"Error decoding base64 data: {e}")
                    continue
                
                if mime_type == 'text/plain':
                    body += decoded
                elif mime_type == 'text/html':
                    html_body += decoded
                    
            if 'parts' in part:
                parse_parts(part['parts'])

    mime_type = payload.get('mimeType', '')
    data = payload.get('body', {}).get('data', '')
    if data:
        try:
            decoded = base64.urlsafe_b64decode(data).decode('utf-8', errors='replace')
        except Exception as e:
            print(f"Error decoding base64 data: {e}")
            decoded = ""
        if mime_type == 'text/plain':
            body = decoded
        elif mime_type == 'text/html':
            html_body = decoded
            
    if 'parts' in payload:
        parse_parts(payload['parts'])
        
    return html_body if html_body else body

sync_stop_event = threading.Event()

# Background sync function
def run_background_sync():
    global sync_info
    if sync_info['status'] == 'syncing':
        return
        
    sync_stop_event.clear()
    sync_info['status'] = 'syncing'
    sync_info['error'] = None
    sync_info['new_messages_fetched'] = 0
    sync_info['current_page'] = 0
    
    try:
        service = get_gmail_service()
        next_page_token = None
        
        # Initial cached count
        conn = get_db_connection()
        cursor = conn.cursor()
        cursor.execute("SELECT count(*) FROM messages")
        sync_info['total_cached'] = cursor.fetchone()[0]
        
        # Check if history sync has been fully completed before
        cursor.execute("SELECT value FROM sync_state WHERE key = 'history_completed'")
        row = cursor.fetchone()
        history_completed = (row is not None and row[0] == '1')
        print(f"SYNC DEBUG: history_completed from DB = {history_completed}, total_cached = {sync_info['total_cached']}")
        conn.close()
        
        while True:
            if sync_stop_event.is_set():
                print("Sync stopped by user request.")
                sync_info['status'] = 'idle'
                break
            # Query Gmail for Promotions and Updates
            # Fetch 100 messages at a time (keeps API requests manageable and UI responsive)
            results = service.users().messages().list(
                userId='me',
                q='category:promotions OR category:updates',
                maxResults=100,
                pageToken=next_page_token
            ).execute()
            
            messages = results.get('messages', [])
            next_page_token = results.get('nextPageToken')
            
            if not messages:
                break
                
            # Filter messages that are already cached
            conn = get_db_connection()
            placeholders = ','.join(['?'] * len(messages))
            cursor = conn.cursor()
            cursor.execute(f"SELECT id FROM messages WHERE id IN ({placeholders})", [m['id'] for m in messages])
            existing_ids = {row['id'] for row in cursor.fetchall()}
            conn.close()
            
            print(f"SYNC DEBUG: Page {sync_info['current_page']} fetched {len(messages)} messages, existing in cache: {len(existing_ids)}")
            
            new_messages = [m for m in messages if m['id'] not in existing_ids]
            
            if new_messages:
                # Fetch metadata in batches of 10 to avoid Gmail concurrent request rate limits
                metadata_list = []
                
                def callback(request_id, response, exception):
                    if exception is None:
                        metadata_list.append(response)
                    else:
                        print(f"Error fetching batch item: {exception}")
                
                batch_size = 10
                for i in range(0, len(new_messages), batch_size):
                    batch = service.new_batch_http_request()
                    for msg in new_messages[i:i+batch_size]:
                        batch.add(
                            service.users().messages().get(
                                userId='me',
                                id=msg['id'],
                                format='metadata',
                                metadataHeaders=['From', 'Subject', 'Date']
                            ),
                            callback=callback
                        )
                    try:
                        batch.execute()
                    except Exception as batch_err:
                        print(f"Batch execution exception: {batch_err}")
                    time.sleep(1.0) # Prevent rate limits
                
                # Check for failed messages and retry them sequentially with a delay
                fetched_ids = {m.get('id') for m in metadata_list if m}
                failed_messages = [m for m in new_messages if m['id'] not in fetched_ids]
                
                if failed_messages:
                    print(f"Retrying {len(failed_messages)} failed messages sequentially...")
                    for msg in failed_messages:
                        try:
                            time.sleep(1.2) # Safe gap
                            response = service.users().messages().get(
                                userId='me',
                                id=msg['id'],
                                format='metadata',
                                metadataHeaders=['From', 'Subject', 'Date']
                            ).execute()
                            metadata_list.append(response)
                        except Exception as retry_err:
                            print(f"Failed to fetch {msg['id']} on retry: {retry_err}")
                
                # Write to database
                conn = get_db_connection()
                cursor = conn.cursor()
                for msg in metadata_list:
                    msg_id = msg.get('id', '')
                    thread_id = msg.get('threadId', '')
                    snippet = msg.get('snippet', '')
                    label_ids = msg.get('labelIds', [])
                    
                    category = 'promotions' if 'CATEGORY_PROMOTIONS' in label_ids else 'updates'
                    unread = 1 if 'UNREAD' in label_ids else 0
                    
                    headers = msg.get('payload', {}).get('headers', [])
                    subject = next((h['value'] for h in headers if h['name'].lower() == 'subject'), '(No Subject)')
                    date = next((h['value'] for h in headers if h['name'].lower() == 'date'), '')
                    timestamp = parse_date_to_timestamp(date)
                    
                    from_header = next((h['value'] for h in headers if h['name'].lower() == 'from'), 'Unknown Sender')
                    
                    email_match = re.search(r'<([^>]+)>', from_header)
                    if email_match:
                        email_address = email_match.group(1).lower().strip()
                        display_name = from_header.split('<')[0].strip(' "')
                    else:
                        email_address = from_header.lower().strip()
                        display_name = from_header
                        
                    if not display_name:
                        display_name = email_address
                        
                    cursor.execute('''
                        INSERT OR REPLACE INTO messages 
                        (id, thread_id, sender_name, sender_email, subject, date, timestamp, snippet, category, unread)
                        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    ''', (msg_id, thread_id, display_name, email_address, subject, date, timestamp, snippet, category, unread))
                
                conn.commit()
                
                # Update sync statistics
                cursor.execute("SELECT count(*) FROM messages")
                sync_info['total_cached'] = cursor.fetchone()[0]
                sync_info['new_messages_fetched'] += len(metadata_list)
                conn.close()
                
            if sync_stop_event.is_set():
                print("Sync stopped by user request.")
                sync_info['status'] = 'idle'
                break
                
            # If we hit already cached messages and we have completed history sync in past,
            # we can stop paging because everything older is guaranteed to be cached.
            if history_completed and len(existing_ids) > 0:
                print("Incremental sync caught up with cached inbox history. Stopping.")
                break
                
            if not next_page_token:
                break
                
            sync_info['current_page'] += 1
            time.sleep(1.0) # Graceful delay between pages
            
        # If we successfully reached the end of the paging, mark history sync completed
        conn = get_db_connection()
        cursor = conn.cursor()
        cursor.execute("INSERT OR REPLACE INTO sync_state (key, value) VALUES ('history_completed', '1')")
        conn.commit()
        conn.close()
        
        sync_info['status'] = 'completed'
        
    except Exception as e:
        print(f"Background Sync Error: {e}")
        sync_info['status'] = 'failed'
        sync_info['error'] = str(e)

def start_sync():
    thread = threading.Thread(target=run_background_sync, daemon=True)
    thread.start()

@app.route('/')
def index():
    return render_template('index.html', api_token=API_TOKEN)

@app.route('/api/status')
def status():
    credentials_present = os.path.exists('credentials.json')
    active_profile = get_active_profile()
    
    # List all linked profiles
    linked_profiles = []
    for file in os.listdir('.'):
        if file.startswith('token_') and file.endswith('.json'):
            linked_profiles.append(file[6:-5])
            
    try:
        if not active_profile:
            raise Exception("No active account linked")
            
        service = get_gmail_service(run_flow=False)
        profile = service.users().getProfile(userId='me').execute()
        
        # Get count of locally cached emails
        conn = get_db_connection()
        cursor = conn.cursor()
        cursor.execute("SELECT count(*) FROM messages")
        cached_count = cursor.fetchone()[0]
        conn.close()
        
        return jsonify({
            'authenticated': True,
            'credentials_present': True,
            'email': profile.get('emailAddress'),
            'messagesTotal': profile.get('messagesTotal'),
            'cachedTotal': cached_count,
            'active_profile': active_profile,
            'linked_profiles': linked_profiles,
            'sync': sync_info
        })
    except Exception as e:
        return jsonify({
            'authenticated': False,
            'credentials_present': credentials_present,
            'active_profile': active_profile,
            'linked_profiles': linked_profiles,
            'error': str(e)
        })

@app.route('/api/auth/link', methods=['POST'])
def link_account():
    try:
        service = get_gmail_service(run_flow=True)
        profile = service.users().getProfile(userId='me').execute()
        email = profile.get('emailAddress')
        
        # Initialize the database for this new profile dynamically
        init_db()
        
        # Pre-populate sync_info count to prevent flickering
        try:
            conn = get_db_connection()
            cursor = conn.cursor()
            cursor.execute("SELECT count(*) FROM messages")
            sync_info['total_cached'] = cursor.fetchone()[0]
            conn.close()
        except Exception:
            sync_info['total_cached'] = 0
            
        sync_info['status'] = 'idle'
        sync_info['current_page'] = 0
        sync_info['new_messages_fetched'] = 0
        
        return jsonify({
            'success': True,
            'message': 'Account linked successfully.',
            'email': email
        })
    except Exception as e:
        return jsonify({'error': str(e)}), 500

@app.route('/api/auth/unlink', methods=['POST'])
def unlink_account():
    try:
        data = request.get_json() or {}
        email = data.get('email') or get_active_profile()
        
        if email:
            token_path = f"token_{email}.json"
            if os.path.exists(token_path):
                os.remove(token_path)
            
            # If we unlinked the active profile, switch to another linked one (or None)
            active = get_active_profile()
            if active == email:
                remaining = []
                for file in os.listdir('.'):
                    if file.startswith('token_') and file.endswith('.json'):
                        remaining.append(file[6:-5])
                if remaining:
                    set_active_profile(remaining[0])
                else:
                    if os.path.exists('settings.json'):
                        os.remove('settings.json')
                        
        sync_info['status'] = 'idle'
        sync_info['current_page'] = 0
        sync_info['new_messages_fetched'] = 0
        
        return jsonify({
            'success': True,
            'message': 'Google Account unlinked successfully.'
        })
    except Exception as e:
        return jsonify({'error': str(e)}), 500

@app.route('/api/auth/switch', methods=['POST'])
def switch_profile():
    try:
        data = request.get_json() or {}
        email = data.get('email')
        if not email:
            return jsonify({'error': 'Missing email parameter'}), 400
            
        token_path = f"token_{email}.json"
        if not os.path.exists(token_path):
            return jsonify({'error': 'Profile token file not found'}), 404
            
        set_active_profile(email)
        init_db()
        
        # Pre-populate sync_info count to prevent flickering
        try:
            conn = get_db_connection()
            cursor = conn.cursor()
            cursor.execute("SELECT count(*) FROM messages")
            sync_info['total_cached'] = cursor.fetchone()[0]
            conn.close()
        except Exception:
            sync_info['total_cached'] = 0
            
        sync_info['status'] = 'idle'
        sync_info['current_page'] = 0
        sync_info['new_messages_fetched'] = 0
        
        return jsonify({
            'success': True,
            'message': f"Switched to profile {email}"
        })
    except Exception as e:
        return jsonify({'error': str(e)}), 500

@app.route('/api/auth/upload-credentials', methods=['POST'])
def upload_credentials():
    try:
        if 'file' not in request.files:
            return jsonify({'error': 'No file part in request'}), 400
        file = request.files['file']
        if file.filename == '':
            return jsonify({'error': 'No selected file'}), 400
        
        file.save('credentials.json')
        return jsonify({
            'success': True,
            'message': 'credentials.json uploaded successfully.'
        })
    except Exception as e:
        return jsonify({'error': str(e)}), 500

@app.route('/api/sync/start', methods=['POST'])
def trigger_sync():
    if sync_info['status'] == 'syncing':
        return jsonify({'message': 'Sync already in progress', 'sync': sync_info})
    sync_stop_event.clear()
    start_sync()
    return jsonify({'message': 'Sync started', 'sync': sync_info})

@app.route('/api/sync/stop', methods=['POST'])
def stop_sync():
    if sync_info['status'] == 'syncing':
        sync_stop_event.set()
        sync_info['status'] = 'idle'
        threading.Thread(target=lambda: (time.sleep(1.5), sync_stop_event.clear())).start()
        return jsonify({'message': 'Sync stopping...', 'sync': sync_info})
    return jsonify({'message': 'Sync is not running', 'sync': sync_info})

@app.route('/api/sync/status')
def get_sync_status():
    return jsonify(sync_info)

@app.route('/api/senders')
def get_senders():
    category = request.args.get('category', 'all')
    
    try:
        conn = get_db_connection()
        cursor = conn.cursor()
        
        # Query distinct senders from cache
        if category == 'all':
            cursor.execute('''
                SELECT sender_email, sender_name, count(*) as count, sum(unread) as unreadCount, max(timestamp) as max_ts
                FROM messages
                GROUP BY sender_email
                ORDER BY max_ts DESC
            ''')
        else:
            cursor.execute('''
                SELECT sender_email, sender_name, count(*) as count, sum(unread) as unreadCount, max(timestamp) as max_ts
                FROM messages
                WHERE category = ?
                GROUP BY sender_email
                ORDER BY max_ts DESC
            ''', (category,))
            
        rows = cursor.fetchall()
        conn.close()
        
        senders_list = []
        for row in rows:
            # Format datetime
            dt = datetime.fromtimestamp(row['max_ts'])
            date_str = dt.strftime('%a, %d %b %Y %H:%M:%S')
            
            senders_list.append({
                'email': row['sender_email'],
                'name': row['sender_name'],
                'count': row['count'],
                'unreadCount': int(row['unreadCount'] or 0),
                'lastUpdated': date_str
            })
            
        return jsonify({
            'senders': senders_list,
            'total_messages': sum(s['count'] for s in senders_list)
        })
        
    except Exception as e:
        print(f"Error fetching senders from DB: {e}")
        return jsonify({'error': str(e)}), 500

@app.route('/api/senders/<path:email>/emails')
def get_sender_emails(email):
    try:
        conn = get_db_connection()
        cursor = conn.cursor()
        
        cursor.execute('''
            SELECT id, subject, date, snippet, unread, timestamp, local_only
            FROM messages
            WHERE sender_email = ?
            ORDER BY timestamp DESC
        ''', (email,))
        
        rows = cursor.fetchall()
        conn.close()
        
        emails_list = []
        for row in rows:
            emails_list.append({
                'id': row['id'],
                'subject': row['subject'],
                'date': row['date'],
                'snippet': row['snippet'],
                'unread': bool(row['unread']),
                'local_only': bool(row['local_only'])
            })
            
        # Group by normalized subject line (accordion logic)
        subject_groups = {}
        for email_item in emails_list:
            subj_norm = normalize_subject(email_item['subject'])
            if subj_norm not in subject_groups:
                subject_groups[subj_norm] = {
                    'subject': email_item['subject'],
                    'count': 0,
                    'unread': False,
                    'emails': []
                }
            subject_groups[subj_norm]['count'] += 1
            if email_item['unread']:
                subject_groups[subj_norm]['unread'] = True
            subject_groups[subj_norm]['emails'].append(email_item)
            
        grouped_list = list(subject_groups.values())
        for group in grouped_list:
            group['date'] = group['emails'][0]['date']
            # Sort emails in group by timestamp desc
            # Since rows were queried ordered by timestamp desc, they are already pre-sorted.
            
        # Sort groups by date descending
        grouped_list.sort(key=lambda x: parse_date_to_timestamp(x['date']), reverse=True)
        
        return jsonify({
            'email': email,
            'groupedEmails': grouped_list
        })
    except Exception as e:
        print(f"Error fetching sender emails: {e}")
        return jsonify({'error': str(e)}), 500

@app.route('/api/emails/<id>')
def get_email_detail(id):
    try:
        conn = get_db_connection()
        cursor = conn.cursor()
        cursor.execute("SELECT body, subject, sender_name, sender_email, date, local_only FROM messages WHERE id = ?", (id,))
        row = cursor.fetchone()
        
        body_content = None
        local_only = bool(row['local_only']) if row else False
        
        if row and row['body']:
            body_content = row['body']
            subject = row['subject']
            from_val = f"{row['sender_name']} <{row['sender_email']}>"
            date = row['date']
            
            # If loaded from cache, still mark read locally
            cursor.execute("UPDATE messages SET unread = 0 WHERE id = ?", (id,))
            conn.commit()
            conn.close()
        elif local_only:
            body_content = "<div style='font-family:sans-serif; color:var(--text-secondary); padding: 40px; text-align:center;'>This email was deleted from the Gmail server and no local backup copy of the body content was preserved.</div>"
            subject = row['subject']
            from_val = f"{row['sender_name']} <{row['sender_email']}>"
            date = row['date']
            
            cursor.execute("UPDATE messages SET unread = 0 WHERE id = ?", (id,))
            conn.commit()
            conn.close()
        else:
            # Body missing in cache, fetch from Gmail API
            conn.close() # Close and reopen after Gmail call to prevent blockages
            
            service = get_gmail_service()
            msg = service.users().messages().get(userId='me', id=id, format='full').execute()
            
            headers = msg.get('payload', {}).get('headers', [])
            subject = next((h['value'] for h in headers if h['name'].lower() == 'subject'), '(No Subject)')
            from_val = next((h['value'] for h in headers if h['name'].lower() == 'from'), 'Unknown Sender')
            date = next((h['value'] for h in headers if h['name'].lower() == 'date'), '')
            
            body_content = get_email_body(msg.get('payload', {}))
            
            # Update SQLite with the fetched body and mark read
            conn = get_db_connection()
            cursor = conn.cursor()
            cursor.execute("UPDATE messages SET body = ?, unread = 0 WHERE id = ?", (body_content, id))
            conn.commit()
            conn.close()
            
            # Attempt to modify unread label on Gmail API (safely)
            if 'UNREAD' in msg.get('labelIds', []):
                try:
                    service.users().messages().batchModify(
                        userId='me',
                        body={'ids': [id], 'removeLabelIds': ['UNREAD']}
                    ).execute()
                except Exception as read_err:
                    print(f"Failed to mark as read on Gmail server: {read_err}")
                    
        return jsonify({
            'id': id,
            'subject': subject,
            'from': from_val,
            'date': date,
            'body': body_content,
            'local_only': local_only
        })
    except Exception as e:
        print(f"Error fetching email detail: {e}")
        return jsonify({'error': str(e)}), 500

@app.route('/api/unsubscribe/links')
def get_unsubscribe_links():
    try:
        conn = get_db_connection()
        cursor = conn.cursor()
        
        # We select senders who have a parsed unsubscribe link (not 'none' and not NULL)
        # We also join to get the total count and unread count for each sender
        cursor.execute('''
            SELECT 
                m.sender_name, 
                m.sender_email, 
                m.unsubscribe_link, 
                m.subject as latest_subject, 
                m.date as latest_date,
                counts.total_count,
                counts.unread_count,
                COALESCE(us.status, CASE WHEN us.sender_email IS NOT NULL THEN 'unsubscribed' ELSE NULL END) as unsub_status
            FROM messages m
            INNER JOIN (
                -- Subquery to aggregate counts per sender
                SELECT 
                    sender_email, 
                    count(*) as total_count, 
                    sum(unread) as unread_count,
                    max(id) as latest_id
                FROM messages
                GROUP BY sender_email
            ) counts ON m.id = counts.latest_id
            LEFT JOIN unsubscribed_senders us ON m.sender_email = us.sender_email
            WHERE m.unsubscribe_link IS NOT NULL AND m.unsubscribe_link != 'none'
            ORDER BY counts.unread_count DESC, counts.total_count DESC
        ''')
        
        rows = cursor.fetchall()
        
        # Calculate remaining count
        cursor.execute('''
            SELECT count(*) FROM (
                SELECT sender_email, max(id) as latest_id 
                FROM messages 
                GROUP BY sender_email
            ) 
            WHERE latest_id NOT IN (
                SELECT id FROM messages WHERE unsubscribe_link IS NOT NULL
            )
        ''')
        remaining_count = cursor.fetchone()[0]
        conn.close()
        
        results = []
        for row in rows:
            results.append({
                'sender_name': row['sender_name'],
                'sender_email': row['sender_email'],
                'unsubscribe_link': row['unsubscribe_link'],
                'latest_subject': row['latest_subject'],
                'latest_date': row['latest_date'],
                'total_count': row['total_count'],
                'unread_count': int(row['unread_count'] or 0),
                'unsub_status': row['unsub_status']
            })
            
        return jsonify({
            'unsubscribe_list': results,
            'remaining_count': remaining_count
        })
        
    except Exception as e:
        print(f"Error fetching unsubscribe links: {e}")
        return jsonify({'error': str(e)}), 500

@app.route('/api/unsubscribe/toggle', methods=['POST'])
def toggle_unsubscribe_status():
    try:
        data = request.json or {}
        sender_email = data.get('sender_email')
        status = data.get('status') # 'initiated', 'unsubscribed', or 'none'
        
        if not sender_email:
            return jsonify({'error': 'Missing sender_email'}), 400
            
        conn = get_db_connection()
        cursor = conn.cursor()
        if status == 'none':
            cursor.execute("DELETE FROM unsubscribed_senders WHERE sender_email = ?", (sender_email,))
        else:
            cursor.execute("INSERT OR REPLACE INTO unsubscribed_senders (sender_email, status, unsubscribed_at) VALUES (?, ?, ?)", 
                           (sender_email, status, time.time()))
          
        conn.commit()
        conn.close()
        
        return jsonify({'success': True, 'sender_email': sender_email, 'status': status})
    except Exception as e:
        print(f"Error toggling unsubscribe status: {e}")
        return jsonify({'error': str(e)}), 500

@app.route('/api/unsubscribe/scan', methods=['POST'])
def scan_unsubscribe():
    try:
        conn = get_db_connection()
        cursor = conn.cursor()
        
        # Get latest message ID for each unique sender that hasn't been scanned yet
        # Prioritized by total email volume descending (unlimited, we slice in python)
        cursor.execute('''
            SELECT sender_email, latest_id, email_count FROM (
                SELECT sender_email, count(*) as email_count, max(id) as latest_id 
                FROM messages 
                GROUP BY sender_email
            ) 
            WHERE latest_id NOT IN (
                SELECT id FROM messages WHERE unsubscribe_link IS NOT NULL
            )
            ORDER BY email_count DESC
        ''')
        rows = cursor.fetchall()
        conn.close()
        
        if not rows:
            return jsonify({'message': 'All senders are already scanned.', 'scanned_count': 0, 'new_links_found': 0, 'remaining_count': 0})
            
        service = get_gmail_service()
        
        new_links_found = 0
        scanned_count = 0
        batch_size = 10
        target_new_links = 100
        max_to_scan = 250 # Safety cap to prevent browser timeout
        
        conn = get_db_connection()
        
        # Iterate over all unscanned senders in batches of 10
        for i in range(0, len(rows), batch_size):
            if new_links_found >= target_new_links or scanned_count >= max_to_scan:
                break
                
            batch_rows = rows[i:i+batch_size]
            metadata_list = []
            
            def callback(request_id, response, exception):
                if exception is None:
                    metadata_list.append(response)
                else:
                    print(f"Error fetching unsubscribe metadata: {exception}")
                    
            batch = service.new_batch_http_request()
            for row in batch_rows:
                batch.add(
                    service.users().messages().get(
                        userId='me',
                        id=row['latest_id'],
                        format='metadata',
                        metadataHeaders=['From', 'List-Unsubscribe']
                    ),
                    callback=callback
                )
                
            try:
                batch.execute()
            except Exception as batch_err:
                print(f"Unsubscribe batch execute error: {batch_err}")
                
            # Process this batch immediately and update DB
            cursor = conn.cursor()
            for msg in metadata_list:
                msg_id = msg.get('id', '')
                headers = msg.get('payload', {}).get('headers', [])
                unsub_header = next((h['value'] for h in headers if h['name'].lower() == 'list-unsubscribe'), '')
                
                unsub_link = 'none'
                if unsub_header:
                    links = re.findall(r'<(https?://[^>]+)>', unsub_header)
                    if links:
                        unsub_link = links[0]
                    else:
                        mailtos = re.findall(r'<(mailto:[^>]+)>', unsub_header)
                        if mailtos:
                            unsub_link = mailtos[0]
                            
                cursor.execute("UPDATE messages SET unsubscribe_link = ? WHERE id = ?", (unsub_link, msg_id))
                scanned_count += 1
                
                if unsub_link != 'none':
                    new_links_found += 1
                    
            conn.commit()
            
            # Throttle requests slightly (using a faster sleep 0.4s to speed up execution)
            time.sleep(0.4)
            
        # Calculate remaining count
        cursor = conn.cursor()
        cursor.execute('''
            SELECT count(*) FROM (
                SELECT sender_email, max(id) as latest_id 
                FROM messages 
                GROUP BY sender_email
            ) 
            WHERE latest_id NOT IN (
                SELECT id FROM messages WHERE unsubscribe_link IS NOT NULL
            )
        ''')
        remaining_count = cursor.fetchone()[0]
        conn.close()
        
        return jsonify({
            'message': f'Scanned {scanned_count} senders. Extracted exactly {new_links_found} new unsubscribe links. {remaining_count} remaining.',
            'scanned_count': scanned_count,
            'new_links_found': new_links_found,
            'remaining_count': remaining_count
        })
        
    except Exception as e:
        print(f"Error scanning unsubscribe links: {e}")
        return jsonify({'error': str(e)}), 500

@app.route('/api/delete-queue', methods=['GET'])
def get_delete_queue():
    try:
        conn = get_db_connection()
        cursor = conn.cursor()
        cursor.execute('''
            SELECT 
                dq.sender_email, 
                dq.status, 
                dq.total_emails,
                counts.sender_name,
                counts.total_count,
                counts.unread_count
            FROM delete_queue dq
            LEFT JOIN (
                SELECT 
                    sender_email, 
                    max(sender_name) as sender_name,
                    count(*) as total_count,
                    sum(unread) as unread_count
                FROM messages
                GROUP BY sender_email
            ) counts ON dq.sender_email = counts.sender_email
            ORDER BY dq.queued_at DESC
        ''')
        rows = cursor.fetchall()
        conn.close()
        
        archive_dir = os.path.join(os.path.dirname(__file__), 'archive')
        
        results = []
        for r in rows:
            sender_email = r['sender_email']
            
            # Check if backup ZIP exists
            zip_filename = f"{sender_email}_archive.zip"
            has_backup = os.path.exists(os.path.join(archive_dir, zip_filename))
            
            # If purged, fall back to total_emails column
            total_count = r['total_count']
            if total_count is None:
                total_count = r['total_emails'] or 0
                
            results.append({
                'sender_email': sender_email,
                'sender_name': r['sender_name'] or r['sender_email'],
                'status': r['status'],
                'total_count': total_count,
                'unread_count': int(r['unread_count'] or 0),
                'has_backup': has_backup
            })
        return jsonify({'delete_queue': results})
    except Exception as e:
        print(f"Error fetching delete queue: {e}")
        return jsonify({'error': str(e)}), 500

@app.route('/api/delete-queue/add', methods=['POST'])
def add_to_delete_queue():
    try:
        data = request.json or {}
        sender_email = data.get('sender_email')
        if not sender_email:
            return jsonify({'error': 'Missing sender_email'}), 400
            
        conn = get_db_connection()
        cursor = conn.cursor()
        
        # Look up current count of messages in DB for this sender
        cursor.execute("SELECT count(*) FROM messages WHERE sender_email = ?", (sender_email,))
        total_emails = cursor.fetchone()[0] or 0
        
        cursor.execute("INSERT OR REPLACE INTO delete_queue (sender_email, queued_at, status, total_emails) VALUES (?, ?, 'pending', ?)", 
                       (sender_email, time.time(), total_emails))
        conn.commit()
        conn.close()
        return jsonify({'success': True, 'message': f'Sender {sender_email} added to delete queue.'})
    except Exception as e:
        print(f"Error adding to delete queue: {e}")
        return jsonify({'error': str(e)}), 500

@app.route('/api/delete-queue/remove', methods=['POST'])
def remove_from_delete_queue():
    try:
        data = request.json or {}
        sender_email = data.get('sender_email')
        if not sender_email:
            return jsonify({'error': 'Missing sender_email'}), 400
            
        conn = get_db_connection()
        cursor = conn.cursor()
        cursor.execute("DELETE FROM delete_queue WHERE sender_email = ?", (sender_email,))
        conn.commit()
        conn.close()
        return jsonify({'success': True, 'message': f'Sender {sender_email} removed from delete queue.'})
    except Exception as e:
        print(f"Error removing from delete queue: {e}")
        return jsonify({'error': str(e)}), 500

@app.route('/api/delete-queue/status', methods=['GET'])
def get_delete_queue_status():
    try:
        sender_email = request.args.get('sender_email')
        if not sender_email:
            return jsonify({'error': 'Missing sender_email'}), 400
            
        conn = get_db_connection()
        cursor = conn.cursor()
        cursor.execute("SELECT status FROM delete_queue WHERE sender_email = ?", (sender_email,))
        row = cursor.fetchone()
        conn.close()
        
        is_queued = row is not None
        status = row['status'] if row else None
        return jsonify({'is_queued': is_queued, 'status': status})
    except Exception as e:
        print(f"Error fetching delete queue status: {e}")
        return jsonify({'error': str(e)}), 500

@app.route('/api/delete-queue/execute', methods=['POST'])
def execute_bulk_delete():
    try:
        data = request.json or {}
        keep_local_backup = bool(data.get('keep_local_backup', False))
        
        target_sender = data.get('sender_email')
        
        conn = get_db_connection()
        cursor = conn.cursor()
        if target_sender:
            cursor.execute("SELECT sender_email FROM delete_queue WHERE sender_email = ? AND status = 'pending'", (target_sender,))
        else:
            cursor.execute("SELECT sender_email FROM delete_queue WHERE status = 'pending'")
        queued_senders = [r['sender_email'] for r in cursor.fetchall()]
        conn.close()
        
        if not queued_senders:
            return jsonify({'message': 'No pending senders in the delete queue.', 'deleted_senders_count': 0})
            
        service = get_gmail_service()
        
        deleted_senders_count = 0
        total_emails_processed = 0
        
        conn = get_db_connection()
        batch_size = 10
        
        for email in queued_senders:
            # 1. Update queue status to processing
            cursor = conn.cursor()
            cursor.execute("UPDATE delete_queue SET status = 'processing' WHERE sender_email = ?", (email,))
            conn.commit()
            
            # 2. Get all message IDs for this sender from local database
            cursor.execute("SELECT id FROM messages WHERE sender_email = ?", (email,))
            msg_ids = [r['id'] for r in cursor.fetchall()]
            
            if msg_ids:
                # 2.1 If keep_local_backup is True, download full bodies first
                if keep_local_backup:
                    cursor.execute("SELECT id FROM messages WHERE sender_email = ? AND (body IS NULL OR body = '')", (email,))
                    missing_body_ids = [r['id'] for r in cursor.fetchall()]
                    
                    if missing_body_ids:
                        print(f"Downloading body backups for {len(missing_body_ids)} emails from {email}...")
                        for j in range(0, len(missing_body_ids), batch_size):
                            batch = service.new_batch_http_request()
                            batch_bodies = {}
                            
                            def body_callback(request_id, response, exception):
                                if exception is None:
                                    msg_id = response.get('id')
                                    payload = response.get('payload', {})
                                    html_content = get_email_body(payload)
                                    batch_bodies[msg_id] = html_content
                                else:
                                    print(f"Error downloading body backup: {exception}")
                                    
                            for msg_id in missing_body_ids[j:j+batch_size]:
                                batch.add(
                                    service.users().messages().get(
                                        userId='me',
                                        id=msg_id,
                                        format='full'
                                    ),
                                    callback=body_callback
                                )
                            try:
                                batch.execute()
                            except Exception as batch_err:
                                print(f"Body backup batch execution exception: {batch_err}")
                                
                            for m_id, b_content in batch_bodies.items():
                                cursor.execute("UPDATE messages SET body = ? WHERE id = ?", (b_content, m_id))
                            conn.commit()
                            time.sleep(0.3)
                            
                    # 2.2 Export messages as a ZIP file in the archive/ folder
                    try:
                        import zipfile
                        archive_dir = os.path.join(os.path.dirname(__file__), 'archive')
                        os.makedirs(archive_dir, exist_ok=True)
                        
                        zip_filename = f"{email}_archive.zip"
                        zip_filepath = os.path.join(archive_dir, zip_filename)
                        
                        # Fetch all emails for this sender from database (now that bodies are downloaded!)
                        cursor.execute("SELECT id, subject, date, body, snippet FROM messages WHERE sender_email = ?", (email,))
                        emails_list = cursor.fetchall()
                        
                        with zipfile.ZipFile(zip_filepath, 'w', zipfile.ZIP_DEFLATED) as archive_zip:
                            for idx, mail in enumerate(emails_list):
                                msg_id = mail['id']
                                subject = mail['subject'] or '(No Subject)'
                                date_val = mail['date']
                                body_content = mail['body'] or mail['snippet'] or 'Empty Body'
                                
                                # Make clean slug for subject
                                safe_subj = "".join([c for c in subject if c.isalpha() or c.isdigit() or c==' ']).rstrip()
                                safe_subj = safe_subj.replace(' ', '_')[:30]
                                file_in_zip = f"{msg_id}_{safe_subj}.html"
                                
                                html_payload = f"""<!DOCTYPE html>
<html>
<head>
    <meta charset="utf-8">
    <title>{subject}</title>
    <style>
        body {{ 
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
            line-height: 1.6; 
            color: #2d3748; 
            padding: 24px; 
            margin: 0;
            background: #f7fafc;
        }}
        .header {{ 
            background: #ffffff; 
            padding: 20px; 
            border-radius: 8px; 
            margin-bottom: 24px; 
            border: 1px solid #e2e8f0;
            box-shadow: 0 1px 3px rgba(0,0,0,0.05);
        }}
        .header div {{ margin-bottom: 8px; }}
        .header div:last-child {{ margin-bottom: 0; }}
        .body {{ 
            border: 1px solid #e2e8f0; 
            padding: 24px; 
            border-radius: 8px; 
            background: #ffffff;
            box-shadow: 0 1px 3px rgba(0,0,0,0.05);
        }}
    </style>
</head>
<body>
    <div class="header">
        <div><strong>Subject:</strong> {subject}</div>
        <div><strong>From:</strong> {email}</div>
        <div><strong>Date:</strong> {date_val}</div>
    </div>
    <div class="body">
        {body_content}
    </div>
</body>
</html>
"""
                                archive_zip.writestr(file_in_zip, html_payload)
                        print(f"ZIP backup created successfully for {email}: {zip_filepath}")
                    except Exception as zip_err:
                        print(f"Failed to create ZIP backup for {email}: {zip_err}")
                            
                # 3. Batch trash on Gmail
                for j in range(0, len(msg_ids), batch_size):
                    batch = service.new_batch_http_request()
                    for msg_id in msg_ids[j:j+batch_size]:
                        batch.add(service.users().messages().trash(userId='me', id=msg_id))
                    try:
                        batch.execute()
                    except Exception as batch_err:
                        print(f"Gmail trash batch execution exception for {email}: {batch_err}")
                    time.sleep(0.3) # Throttle to prevent rate limit
                
                # 4. Database sync based on local backup preference
                if keep_local_backup:
                    # Keep local backup, mark messages as local_only
                    cursor.execute("UPDATE messages SET local_only = 1 WHERE sender_email = ?", (email,))
                else:
                    # Purge from local cache
                    cursor.execute("DELETE FROM messages WHERE sender_email = ?", (email,))
                    
                total_emails_processed += len(msg_ids)
                
            # 5. Update status to completed since deletion is complete
            cursor.execute("UPDATE delete_queue SET status = 'completed' WHERE sender_email = ?", (email,))
            conn.commit()
            deleted_senders_count += 1
            
        conn.close()
        
        backup_status = "locally archived and zipped" if keep_local_backup else "completely purged"
        return jsonify({
            'message': f'Successfully bulk deleted {deleted_senders_count} senders ({total_emails_processed} emails total) on Gmail. Local copy {backup_status}.',
            'deleted_senders_count': deleted_senders_count,
            'total_emails_processed': total_emails_processed
        })
        
    except Exception as e:
        print(f"Error executing bulk delete: {e}")
        return jsonify({'error': str(e)}), 500

@app.route('/api/archives', methods=['GET'])
def list_archives():
    try:
        archive_dir = os.path.join(os.path.dirname(__file__), 'archive')
        if not os.path.exists(archive_dir):
            os.makedirs(archive_dir, exist_ok=True)
            
        files = os.listdir(archive_dir)
        archives = []
        for file in files:
            if file.endswith('.zip'):
                filepath = os.path.join(archive_dir, file)
                stat_info = os.stat(filepath)
                # Parse email from filename (<email>_archive.zip)
                sender_email = file.replace('_archive.zip', '')
                
                archives.append({
                    'filename': file,
                    'sender_email': sender_email,
                    'size_bytes': stat_info.st_size,
                    'created_at': stat_info.st_mtime # Modified time as proxy for creation
                })
        # Sort archives by created_at desc
        archives.sort(key=lambda x: x['created_at'], reverse=True)
        return jsonify({'archives': archives})
    except Exception as e:
        print(f"Error listing archives: {e}")
        return jsonify({'error': str(e)}), 500

@app.route('/api/archives/download/<path:filename>', methods=['GET'])
def download_archive(filename):
    try:
        archive_dir = os.path.join(os.path.dirname(__file__), 'archive')
        # Check security (ensure filename doesn't contain directory traversal like ..)
        if '..' in filename or filename.startswith('/') or filename.startswith('\\'):
            return jsonify({'error': 'Invalid filename'}), 400
            
        filepath = os.path.join(archive_dir, filename)
        if not os.path.exists(filepath):
            return jsonify({'error': 'Archive file not found'}), 404
            
        return send_from_directory(archive_dir, filename, as_attachment=True)
    except Exception as e:
        print(f"Error downloading archive: {e}")
        return jsonify({'error': str(e)}), 500

if __name__ == '__main__':
    init_db()
    app.run(debug=True, port=5000, use_reloader=False) # Disable reloader to prevent duplicate threads on startup
