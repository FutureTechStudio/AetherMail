# AetherMail - Gmail Cleaner & Bulk Archiver

A premium Single-Page Application (SPA) dashboard designed to help you declutter your Gmail inbox. It extracts unsubscribe links, allows you to batch-delete notification threads by sender email, and automatically packages them into offline-readable `.zip` archives.

---

## Key Features
1. **Unsubscribe Helper**: Scan and list senders containing unsubscribe options, sort by volume, and navigate with top-right aligned pagination.
2. **Bulk Delete Manager**:
   - **Queue Tab**: Review and queue senders to be deleted from Gmail in bulk.
   - **Deleted Tab**: View process history and access direct download links to ZIP backups.
   - **Progressive Deletion**: Watch deletions execute sequentially in real-time with progress bar loaders and navigation safety guards.
3. **ZIP Archiver**: Saves local backups of deleted messages inside an offline-readable HTML package (`archive/<sender>_archive.zip`) which can be downloaded directly from the UI.
4. **Sleek UX**: Pure custom styling, glassmorphic confirmation modal overlays, animated badge spinners, and deep URL hash-routing synchronization (bookmarkable tabs).

---

## Setup & Running Guide (Windows)

The repository includes a helper script `run.bat` that fully automates the environment setup and dependency installation.

### Step 1: Clone and Place Credentials
Before running the application, you need to provide your Google OAuth Client ID credentials:
1. Go to the [Google Cloud Console](https://console.cloud.google.com).
2. Create/select a project, and enable the **Gmail API**.
3. Configure the **OAuth Consent Screen** (add your Gmail email as a Test User).
4. Go to **Credentials**, click **Create Credentials** $\rightarrow$ **OAuth Client ID** (select **Desktop Application** or Web App).
5. Download the JSON credential file, rename it to `credentials.json`, and place it in this project's root folder.

### Step 2: Setup and Start the Application
Double-click the **`run.bat`** file in the project folder. It will:
- Check if Python is installed.
- Initialize the Python Virtual Environment (`.venv`).
- Install and upgrade all dependencies (`requirements.txt`).
- Prompt you if `credentials.json` is missing.
- Boot the Flask web server automatically.

Once started, open your browser and navigate to:
👉 **[http://127.0.0.1:5000](http://127.0.0.1:5000)**

On your first run, you will be prompted in the browser to sign in to your Google Account and grant the application permissions (`gmail.readonly` and `gmail.modify`) to read and trash mails.
