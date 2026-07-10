// App State
let state = {
    currentCategory: 'all',
    senders: [],
    selectedSender: null,
    selectedEmailId: null,
    status: null,
    searchQuery: '',
    syncInterval: null,
    isDeleting: false,
    activeHash: ''
};

// Unsubscribe Helper State
let unsubState = {
    list: [],
    currentPage: 1,
    pageSize: 100,
    remainingCount: 0
};

// Bulk Delete State
let bulkDeleteState = {
    activeTab: 'queue',
    list: []
};

// API Fetch Wrapper with API Token verification header
const apiToken = document.querySelector('meta[name="api-token"]').getAttribute('content');

async function apiFetch(url, options = {}) {
    const defaultHeaders = {
        'Content-Type': 'application/json',
        'X-API-Token': apiToken
    };
    const headers = { ...defaultHeaders, ...options.headers };
    return fetch(url, { ...options, headers });
}

// DOM Elements
const elements = {
    senderSearch: document.getElementById('sender-search-input'),
    navItems: document.querySelectorAll('.nav-item'),
    badgeAll: document.getElementById('badge-all'),
    badgePromotions: document.getElementById('badge-promotions'),
    badgeUpdates: document.getElementById('badge-updates'),
    accountStatus: document.getElementById('account-status'),
    refreshBtn: document.getElementById('refresh-btn'),
    sendersCount: document.getElementById('senders-count-summary'),
    sendersLoader: document.getElementById('senders-loader'),
    senderCards: document.getElementById('sender-cards'),
    emailsPaneHeader: document.getElementById('emails-pane-header'),
    selectedSenderName: document.getElementById('selected-sender-name'),
    selectedSenderEmail: document.getElementById('selected-sender-email'),
    emailsListContainer: document.getElementById('emails-list-container'),
    emailsAccordion: document.getElementById('emails-accordion'),
    emailSubjectView: document.getElementById('email-subject-view'),
    emailFromView: document.getElementById('email-from-view'),
    emailDateView: document.getElementById('email-date-view'),
    emailBodyWrapper: document.getElementById('email-body-wrapper'),
    emailIframe: document.getElementById('email-body-iframe'),
    readerContentContainer: document.getElementById('reader-content-container'),
    
    // Sync UI elements
    syncIndicator: document.getElementById('sync-indicator'),
    syncProgress: document.getElementById('sync-progress'),
    syncDetails: document.getElementById('sync-details'),
    triggerSyncBtn: document.getElementById('trigger-sync-btn'),
    senderSort: document.getElementById('sender-sort-select'),

    // Unsubscribe Tool UI elements
    scanUnsubBtn: document.getElementById('scan-unsub-btn'),
    startScanBtn: document.getElementById('unsub-start-scan-btn'),
    unsubTableContainer: document.getElementById('unsub-table-container'),
    unsubTableBody: document.getElementById('unsub-table-body'),
    unsubPlaceholder: document.getElementById('unsub-placeholder'),

    // Bulk Delete Tool UI elements
    queueDeleteBtn: document.getElementById('queue-delete-btn'),
    navBulkDelete: document.getElementById('nav-bulk-delete'),
    bulkDeleteView: document.getElementById('bulk-delete-view'),
    bulkDeletePlaceholder: document.getElementById('bulk-delete-placeholder'),
    bulkDeleteTableContainer: document.getElementById('bulk-delete-table-container'),
    bulkDeleteTableBody: document.getElementById('bulk-delete-table-body'),
    startBulkDeleteBtn: document.getElementById('start-bulk-delete-btn'),
    keepBackupCheckbox: document.getElementById('keep-backup-checkbox'),

    // Archived Backups UI elements
    navArchives: document.getElementById('nav-archives'),
    archivesView: document.getElementById('archives-view'),
    archivesPlaceholder: document.getElementById('archives-placeholder'),
    archivesTableContainer: document.getElementById('archives-table-container'),
    archivesTableBody: document.getElementById('archives-table-body')
};

// Initialize Application
document.addEventListener('DOMContentLoaded', () => {
    initApp();
});

async function initApp() {
    lucide.createIcons();
    bindEvents();
    
    // Check initial status (which also returns sync state)
    await checkStatus();
    
    if (state.status && state.status.authenticated) {
        // Run router initialization
        window.addEventListener('hashchange', handleRouting);
        handleRouting();
        
        // Start polling sync status
        startSyncPolling();
    } else {
        showError('senders', 'Could not link to your Google Account. Verify your credentials.');
    }
}

// Bind Event Listeners
function bindEvents() {
    // Navigation
    elements.navItems.forEach(item => {
        item.addEventListener('click', async (e) => {
            if (state.isDeleting) {
                await showAppAlert("Navigation Locked", "Please wait until the active deletion process completes.", "warning");
                e.preventDefault();
                return;
            }
            
            const category = item.getAttribute('data-category');
            if (!category) return;
            
            e.preventDefault();
            window.location.hash = `#/category/${category}`;
        });
    });

    // Refresh button
    elements.refreshBtn.addEventListener('click', () => {
        fetchSenders();
    });

    // Search filter
    elements.senderSearch.addEventListener('input', (e) => {
        state.searchQuery = e.target.value.toLowerCase().trim();
        renderSenders();
    });

    // Sort selector change
    elements.senderSort.addEventListener('change', () => {
        renderSenders();
    });

    // Unsubscribe scanning buttons
    if (elements.scanUnsubBtn) {
        elements.scanUnsubBtn.addEventListener('click', runUnsubscribeScan);
    }
    if (elements.startScanBtn) {
        elements.startScanBtn.addEventListener('click', runUnsubscribeScan);
    }

    // Queue for Delete Button
    if (elements.queueDeleteBtn) {
        elements.queueDeleteBtn.addEventListener('click', async () => {
            if (!state.selectedSender) return;
            const email = state.selectedSender.email;
            
            try {
                elements.queueDeleteBtn.disabled = true;
                const statusRes = await apiFetch(`/api/delete-queue/status?sender_email=${encodeURIComponent(email)}`);
                const statusData = await statusRes.json();
                
                const isQueued = statusData.is_queued;
                const endpoint = isQueued ? '/api/delete-queue/remove' : '/api/delete-queue/add';
                
                const res = await apiFetch(endpoint, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ sender_email: email })
                });
                const data = await res.json();
                if (data.success) {
                    updateQueueDeleteButtonState(!isQueued);
                } else {
                    await showAppAlert("Operation Failed", data.error, "warning");
                }
            } catch (err) {
                console.error("Queue delete toggle error", err);
            } finally {
                elements.queueDeleteBtn.disabled = false;
            }
        });
    }

    // Start Bulk Delete Button
    if (elements.startBulkDeleteBtn) {
        elements.startBulkDeleteBtn.addEventListener('click', runBulkDelete);
    }

    // Trigger manual Sync
    elements.triggerSyncBtn.addEventListener('click', async () => {
        try {
            elements.triggerSyncBtn.disabled = true;
            const res = await apiFetch('/api/sync/start', { method: 'POST' });
            const data = await res.json();
            updateSyncUI(data.sync);
            startSyncPolling();
        } catch (err) {
            console.error("Failed to start sync", err);
        } finally {
            elements.triggerSyncBtn.disabled = false;
        }
    });
}

// Check Authentication & Local Status
async function checkStatus() {
    try {
        const response = await apiFetch('/api/status');
        const data = await response.json();
        state.status = data;
        
        if (data.authenticated) {
            const initial = data.email ? data.email.charAt(0).toUpperCase() : 'G';
            elements.accountStatus.innerHTML = `
                <div id="profile-switcher-menu" class="profile-switcher-menu" style="display: none;"></div>
                <div class="account-status-card" onclick="toggleProfileSwitcher(event)" style="cursor: pointer; display: flex; align-items: center; justify-content: space-between; width: 100%;">
                    <div style="display: flex; align-items: center; gap: 12px; min-width: 0; flex: 1;">
                        <div class="account-avatar">${initial}</div>
                        <div class="account-info" style="flex: 1; min-width: 0;">
                            <div class="account-name" style="display: flex; align-items: center; gap: 6px;">
                                <span>Google Account</span>
                                <i data-lucide="chevron-up" style="width: 12px; height: 12px; color: var(--text-muted);"></i>
                            </div>
                            <div class="account-email" title="${data.email}">${data.email}</div>
                        </div>
                    </div>
                </div>
            `;
            
            // Initial sync UI update
            if (data.sync) {
                updateSyncUI(data.sync);
            }
        } else {
            if (!data.credentials_present) {
                // Missing credentials.json
                elements.accountStatus.innerHTML = `
                    <div id="profile-switcher-menu" class="profile-switcher-menu" style="display: none;"></div>
                    <div class="account-status-card" style="flex-direction: column; align-items: flex-start; gap: 8px; width: 100%;">
                        <div style="display: flex; align-items: center; gap: 8px; color: #ef4444; width: 100%;">
                            <i data-lucide="alert-triangle" style="flex-shrink: 0;"></i>
                            <div class="account-name" style="font-weight:600; white-space: normal;">Missing credentials.json</div>
                        </div>
                        <p style="font-size: 11px; color: var(--text-muted); margin: 0; line-height: 1.4;">
                            Configure OAuth in Google Cloud Console, download client secrets JSON, and upload it:
                        </p>
                        <label class="sync-action-btn" style="width: 100%; justify-content: center; cursor: pointer; margin-top: 4px; border-color: rgba(59, 130, 246, 0.3); color: #3b82f6; display: flex; align-items: center; gap: 6px; box-sizing: border-box;">
                            <i data-lucide="upload-cloud" style="width: 14px; height: 14px;"></i>
                            <span>Upload credentials.json</span>
                            <input type="file" id="credentials-file-input" style="display:none;" onchange="handleCredentialsUpload(event)">
                        </label>
                    </div>
                `;
            } else {
                // Credentials present but not authenticated
                elements.accountStatus.innerHTML = `
                    <div id="profile-switcher-menu" class="profile-switcher-menu" style="display: none;"></div>
                    <div class="account-status-card" onclick="toggleProfileSwitcher(event)" style="cursor: pointer; display: flex; align-items: center; justify-content: space-between; width: 100%; margin-bottom: 8px;">
                        <div style="display: flex; align-items: center; gap: 8px; color: #f59e0b; width: 100%;">
                            <i data-lucide="key-round" style="flex-shrink: 0;"></i>
                            <div class="account-name" style="font-weight:600; white-space: normal; display: flex; align-items: center; gap: 6px;">
                                <span>Google Link Required</span>
                                <i data-lucide="chevron-up" style="width: 12px; height: 12px; color: var(--text-muted);"></i>
                            </div>
                        </div>
                    </div>
                    <button onclick="linkGoogleAccount(event)" class="sync-action-btn" style="width: 100%; justify-content: center; margin-top: 4px; background: var(--primary-gradient); border: none; color: white; display: flex; align-items: center; gap: 6px; cursor: pointer; box-sizing: border-box;">
                        <i data-lucide="link" style="width: 14px; height: 14px;"></i>
                        <span>Link Google Account</span>
                    </button>
                `;
            }
        }
        
        // Populate profile switcher menu
        const menu = document.getElementById('profile-switcher-menu');
        if (menu) {
            let listHtml = '';
            if (data.linked_profiles && data.linked_profiles.length > 0) {
                listHtml = data.linked_profiles.map(email => {
                    const isActive = email === data.active_profile;
                    const activeClass = isActive ? 'active' : '';
                    const checkIcon = isActive ? '<i data-lucide="check" style="color: #10b981; width:14px; height:14px; margin-left:auto;"></i>' : '';
                    const pInitial = email.charAt(0).toUpperCase();
                    return `
                        <div class="profile-switcher-item ${activeClass}" onclick="switchActiveProfile('${email}')">
                            <div class="account-avatar" style="width:24px; height:24px; font-size:10px; flex-shrink:0;">${pInitial}</div>
                            <span class="profile-item-email" title="${email}">${email}</span>
                            ${checkIcon}
                        </div>
                    `;
                }).join('');
            } else {
                listHtml = '<div style="font-size:11px; color:var(--text-muted); text-align:center; padding:8px 0;">No accounts linked</div>';
            }
            
            menu.innerHTML = `
                <div class="profile-switcher-header">Linked Profiles</div>
                <div class="profile-switcher-list">
                    ${listHtml}
                </div>
                <div class="profile-switcher-footer">
                    <button onclick="linkGoogleAccount(event)" class="switcher-action-btn primary">
                        <i data-lucide="plus" style="width:13px; height:13px;"></i>
                        <span>Link another account...</span>
                    </button>
                    ${data.authenticated ? `
                    <button onclick="unlinkGoogleAccount(event)" class="switcher-action-btn danger">
                        <i data-lucide="trash-2" style="width:13px; height:13px;"></i>
                        <span>Unlink active account</span>
                    </button>
                    ` : ''}
                </div>
            `;
        }
        
        lucide.createIcons();
    } catch (err) {
        console.error("Status check failed", err);
    }
}

// Fetch unique senders from local SQLite DB
async function fetchSenders(silent = false) {
    if (!silent) showLoader();
    
    try {
        const response = await apiFetch(`/api/senders?category=${state.currentCategory}`);
        if (!response.ok) throw new Error("HTTP error " + response.status);
        const data = await response.json();
        
        state.senders = data.senders || [];
        updateSidebarBadges(data.total_messages);
        
        renderSenders();
        
        // If a sender was previously selected, reload their list of emails dynamically
        if (state.selectedSender) {
            const updatedSender = state.senders.find(s => s.email === state.selectedSender.email);
            if (updatedSender) {
                state.selectedSender = updatedSender;
                // Silently reload the accordion to reflect newly arrived messages
                reloadEmailsList(updatedSender);
            }
        }
    } catch (err) {
        console.error("Error fetching senders", err);
        if (!silent) showError('senders', 'Could not query the cached database.');
    }
}

function showLoader() {
    elements.sendersLoader.style.display = 'flex';
    elements.senderCards.style.display = 'none';
    elements.sendersCount.textContent = 'Loading...';
}

function updateSidebarBadges(totalCount) {
    if (state.currentCategory === 'all') {
        elements.badgeAll.textContent = totalCount;
    } else if (state.currentCategory === 'promotions') {
        elements.badgePromotions.textContent = totalCount;
    } else if (state.currentCategory === 'updates') {
        elements.badgeUpdates.textContent = totalCount;
    }
}

// Render Sender Cards
function renderSenders() {
    elements.sendersLoader.style.display = 'none';
    elements.senderCards.style.display = 'flex';
    
    let filteredSenders = state.senders.filter(sender => {
        return sender.name.toLowerCase().includes(state.searchQuery) ||
               sender.email.toLowerCase().includes(state.searchQuery);
    });
    
    // Sort senders
    const sortBy = elements.senderSort ? elements.senderSort.value : 'date';
    if (sortBy === 'alpha') {
        filteredSenders.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
    } else if (sortBy === 'count') {
        filteredSenders.sort((a, b) => b.count - a.count);
    } else { // default 'date'
        filteredSenders.sort((a, b) => {
            const dateA = new Date(a.lastUpdated).getTime();
            const dateB = new Date(b.lastUpdated).getTime();
            return dateB - dateA;
        });
    }
    
    elements.sendersCount.textContent = `${filteredSenders.length} senders`;
    
    if (filteredSenders.length === 0) {
        elements.senderCards.innerHTML = `
            <div class="pane-message" style="height: auto; padding-top: 40px;">
                <i data-lucide="help-circle" style="width: 32px; height: 32px; color: var(--text-muted);"></i>
                <p>No senders found.</p>
            </div>
        `;
        lucide.createIcons();
        return;
    }
    
    elements.senderCards.innerHTML = filteredSenders.map(sender => {
        const initials = sender.name ? sender.name.substring(0, 2).toUpperCase() : '?';
        const hasUnread = sender.unreadCount > 0;
        const isActive = state.selectedSender && state.selectedSender.email === sender.email;
        
        return `
            <div class="sender-card ${isActive ? 'active' : ''}" onclick="selectSender('${sender.email}')">
                <div class="sender-avatar">${initials}</div>
                <div class="sender-card-info">
                    <div class="sender-card-meta">
                        <span class="sender-name" title="${sender.name}">${sender.name}</span>
                        <div class="sender-badge-container">
                            <span class="sender-count-badge ${hasUnread ? 'unread' : ''}">${sender.unreadCount}/${sender.count}</span>
                            ${hasUnread ? '<span class="unread-dot"></span>' : ''}
                        </div>
                    </div>
                    <div class="sender-email" title="${sender.email}">${sender.email}</div>
                </div>
            </div>
        `;
    }).join('');
    
    lucide.createIcons();
}

// Select a Sender
async function selectSender(email) {
    // Show active state immediately
    const sender = state.senders.find(s => s.email === email);
    if (!sender) return;
    
    state.selectedSender = sender;
    renderSenders();
    
    elements.selectedSenderName.textContent = sender.name;
    elements.selectedSenderEmail.textContent = sender.email;
    
    // Show delete queue button and fetch status
    if (elements.queueDeleteBtn) {
        elements.queueDeleteBtn.style.display = 'inline-flex';
        checkSenderQueueStatus(email);
    }
    
    // Fetch emails for this sender from database
    showEmailsLoader();
    
    try {
        const response = await apiFetch(`/api/senders/${email}/emails`);
        const data = await response.json();
        
        sender.groupedEmails = data.groupedEmails || [];
        renderEmailsList(sender);
    } catch (err) {
        console.error("Error loading sender emails", err);
        showEmailsError();
    }
}

function showEmailsLoader() {
    elements.emailsAccordion.style.display = 'none';
    let placeholder = elements.emailsListContainer.querySelector('.selection-placeholder');
    if (!placeholder) {
        placeholder = document.createElement('div');
        placeholder.className = 'pane-message selection-placeholder';
        elements.emailsListContainer.insertBefore(placeholder, elements.emailsAccordion);
    }
    placeholder.style.display = 'flex';
    placeholder.innerHTML = `
        <div class="spinner"></div>
        <h3>Loading Messages...</h3>
    `;
}

function showEmailsError() {
    const placeholder = elements.emailsListContainer.querySelector('.selection-placeholder');
    placeholder.style.display = 'flex';
    placeholder.innerHTML = `
        <div class="placeholder-art" style="color:hsl(0,85%,65%)">
            <i data-lucide="alert-triangle"></i>
        </div>
        <h3>Failed to load emails</h3>
    `;
    lucide.createIcons();
}

// Silently refresh the emails list accordion
async function reloadEmailsList(sender) {
    try {
        const response = await apiFetch(`/api/senders/${sender.email}/emails`);
        const data = await response.json();
        sender.groupedEmails = data.groupedEmails || [];
        
        // Render without clearing/resetting scroll if possible
        // But to keep it simple, we just redraw the accordion
        renderEmailsList(sender);
    } catch (err) {
        console.error("Silent reload failed", err);
    }
}

// Render Accordions
function renderEmailsList(sender) {
    const placeholder = elements.emailsListContainer.querySelector('.selection-placeholder');
    if (placeholder) placeholder.style.display = 'none';
    
    elements.emailsAccordion.style.display = 'flex';
    
    if (!sender.groupedEmails || sender.groupedEmails.length === 0) {
        elements.emailsAccordion.innerHTML = `
            <div class="pane-message">
                <p>No emails found for this sender.</p>
            </div>
        `;
        return;
    }
    
    elements.emailsAccordion.innerHTML = sender.groupedEmails.map((group, index) => {
        const isMultiple = group.count > 1;
        const dateFormatted = formatDate(group.date);
        
        const subEmailsHtml = group.emails.map(email => {
            const emailDate = formatTimeOrDate(email.date);
            const isEmailActive = state.selectedEmailId === email.id;
            
            return `
                <div class="child-email-item ${email.unread ? 'unread' : ''} ${isEmailActive ? 'active' : ''}" 
                     onclick="viewEmail('${email.id}', event)">
                    <span class="child-email-date">${emailDate}</span>
                    <div class="child-email-snippet" title="${email.snippet}">${email.snippet}</div>
                </div>
            `;
        }).join('');
        
        return `
            <div class="accordion-group" id="acc-group-${index}">
                <div class="accordion-header" onclick="${isMultiple ? `toggleAccordion(${index})` : `viewEmail('${group.emails[0].id}', event)`}">
                    ${isMultiple ? '<i data-lucide="chevron-right" class="accordion-chevron"></i>' : '<i data-lucide="mail" class="accordion-chevron" style="transform:none;opacity:0.6"></i>'}
                    <div class="accordion-header-content">
                        <div class="accordion-subject" title="${group.subject}">${group.subject}</div>
                        <div class="accordion-meta">
                            ${isMultiple ? `<span class="accordion-count-badge">${group.count} emails</span>` : ''}
                            <span class="accordion-date">${dateFormatted}</span>
                        </div>
                    </div>
                </div>
                ${isMultiple ? `
                    <div class="accordion-content">
                        <div class="child-email-list">
                            ${subEmailsHtml}
                        </div>
                    </div>
                ` : ''}
            </div>
        `;
    }).join('');
    
    lucide.createIcons();
}

function toggleAccordion(index) {
    const groupElement = document.getElementById(`acc-group-${index}`);
    if (!groupElement) return;
    
    const isOpen = groupElement.classList.contains('open');
    document.querySelectorAll('.accordion-group').forEach(g => g.classList.remove('open'));
    
    if (!isOpen) {
        groupElement.classList.add('open');
    }
}

// Fetch and Read Specific Email
async function viewEmail(id, event) {
    if (event) event.stopPropagation();
    
    state.selectedEmailId = id;
    
    // Manage active highlights
    document.querySelectorAll('.child-email-item').forEach(item => item.classList.remove('active'));
    if (event && event.currentTarget) {
        event.currentTarget.classList.add('active');
    }
    
    showReaderLoading();
    
    try {
        const response = await apiFetch(`/api/emails/${id}`);
        if (!response.ok) throw new Error("HTTP error " + response.status);
        const data = await response.json();
        
        if (data.local_only) {
            elements.emailSubjectView.innerHTML = `${data.subject} <span class="local-only-tag" style="margin-left: 8px;"><i data-lucide="archive" style="width: 10px; height: 10px; margin-right: 4px;"></i> Local Backup</span>`;
        } else {
            elements.emailSubjectView.textContent = data.subject;
        }
        elements.emailFromView.textContent = data.from;
        elements.emailDateView.textContent = formatDateFull(data.date);
        
        elements.emailIframe.srcdoc = `
            <html>
                <head>
                    <style>
                        body { 
                            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
                            line-height: 1.6;
                            color: #2D3748;
                            padding: 20px;
                            margin: 0;
                            background-color: #ffffff;
                        }
                        a { color: #4F46E5; text-decoration: underline; }
                        img { max-width: 100% !important; height: auto !important; }
                        blockquote { border-left: 4px solid #E2E8F0; padding-left: 16px; margin-left: 0; color: #718096; }
                    </style>
                </head>
                <body>
                    ${data.body || '<p style="color:#718096">Empty Email Body</p>'}
                </body>
            </html>
        `;
        
        elements.readerContentContainer.querySelector('.selection-placeholder').style.display = 'none';
        elements.emailBodyWrapper.style.display = 'block';
        
        // Handle read markings locally
        markEmailReadLocally(id);
    } catch (err) {
        console.error("Error loading email content", err);
        showReaderError();
    }
}

function showReaderLoading() {
    elements.emailBodyWrapper.style.display = 'none';
    const placeholder = elements.readerContentContainer.querySelector('.selection-placeholder');
    placeholder.style.display = 'flex';
    placeholder.innerHTML = `
        <div class="spinner"></div>
        <h3>Loading Content...</h3>
        <p>Retrieving secure body...</p>
    `;
}

function showReaderError() {
    elements.emailBodyWrapper.style.display = 'none';
    const placeholder = elements.readerContentContainer.querySelector('.selection-placeholder');
    placeholder.style.display = 'flex';
    placeholder.innerHTML = `
        <div class="placeholder-art" style="color:hsl(0,85%,65%)">
            <i data-lucide="alert-triangle"></i>
        </div>
        <h3>Error Loading Email</h3>
    `;
    lucide.createIcons();
}

function markEmailReadLocally(id) {
    if (!state.selectedSender) return;
    
    let updatedAny = false;
    state.selectedSender.groupedEmails.forEach(group => {
        group.emails.forEach(email => {
            if (email.id === id && email.unread) {
                email.unread = false;
                state.selectedSender.unreadCount = Math.max(0, state.selectedSender.unreadCount - 1);
                updatedAny = true;
            }
        });
        group.unread = group.emails.some(e => e.unread);
    });
    
    if (updatedAny) {
        renderSenders();
        renderEmailsList(state.selectedSender);
    }
}

// Syncing Polling Mechanics
function startSyncPolling() {
    if (state.syncInterval) return;
    
    // Poll immediately
    pollSyncStatus();
    
    // Set 3 seconds interval
    state.syncInterval = setInterval(pollSyncStatus, 3000);
}

async function pollSyncStatus() {
    try {
        const response = await apiFetch('/api/sync/status');
        const data = await response.json();
        
        updateSyncUI(data);
        
        if (data.status !== 'syncing') {
            // Stop polling if completed or failed
            if (state.syncInterval) {
                clearInterval(state.syncInterval);
                state.syncInterval = null;
            }
            // Final refresh to ensure everything is synced
            fetchSenders(true);
        } else {
            // Silently refresh list to display new senders/emails as they sync
            fetchSenders(true);
        }
    } catch (err) {
        console.error("Error polling sync status", err);
    }
}

function updateSyncUI(syncData) {
    // 1. Text status & badge class
    elements.syncIndicator.textContent = syncData.status;
    elements.syncIndicator.className = `sync-indicator ${syncData.status}`;
    
    // 2. Details text
    elements.syncDetails.textContent = `${syncData.total_cached.toLocaleString()} emails cached`;
    
    // 3. Progress bar width
    // Show progress relative to 5000 emails max or let it animate
    const pct = Math.min(100, (syncData.total_cached / 5000) * 100);
    elements.syncProgress.style.width = `${pct}%`;
    
    // If syncing, disable manual sync button and rotate its icon
    if (syncData.status === 'syncing') {
        elements.triggerSyncBtn.innerHTML = `<i data-lucide="loader-2" class="spinner-small" style="margin-right:6px"></i> Syncing...`;
        elements.triggerSyncBtn.disabled = true;
    } else {
        elements.triggerSyncBtn.innerHTML = `<i data-lucide="refresh-cw"></i> Sync Inbox`;
        elements.triggerSyncBtn.disabled = false;
    }
    
    lucide.createIcons();
}

// Formatters
function formatDate(dateStr) {
    if (!dateStr) return '';
    try {
        const d = new Date(dateStr);
        if (isNaN(d.getTime())) return dateStr;
        return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
    } catch {
        return dateStr;
    }
}

function formatTimeOrDate(dateStr) {
    if (!dateStr) return '';
    try {
        const d = new Date(dateStr);
        if (isNaN(d.getTime())) return dateStr;
        
        const today = new Date();
        if (d.toDateString() === today.toDateString()) {
            return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
        }
        return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
    } catch {
        return dateStr;
    }
}

function formatDateFull(dateStr) {
    if (!dateStr) return '';
    try {
        const d = new Date(dateStr);
        if (isNaN(d.getTime())) return dateStr;
        return d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
    } catch {
        return dateStr;
    }
}

function showError(scope, msg) {
    if (scope === 'senders') {
        elements.sendersLoader.style.display = 'none';
        elements.senderCards.style.display = 'none';
        elements.sendersCount.textContent = 'Error';
        elements.sendersListContainer.innerHTML = `
            <div class="pane-message" style="color: hsl(0, 85%, 65%);">
                <i data-lucide="alert-octagon" style="width:40px; height:40px; margin-bottom:12px;"></i>
                <h3>Database Error</h3>
                <p>${msg}</p>
            </div>
        `;
        lucide.createIcons();
    }
}

// Collapsible Navigation sections
function toggleNavSection(id) {
    const header = document.querySelector(`.collapsible-header[onclick*="${id}"]`);
    const content = document.getElementById(`${id}-content`);
    if (!header || !content) return;
    
    const isOpen = content.classList.contains('open');
    if (isOpen) {
        header.classList.remove('open');
        content.classList.remove('open');
    } else {
        header.classList.add('open');
        content.classList.add('open');
    }
}

// Open Unsubscribe Helper Tool
async function openUnsubscribeTool(event) {
    if (state.isDeleting) {
        await showAppAlert("Navigation Locked", "Please wait until the active deletion process completes.", "warning");
        if (event) event.preventDefault();
        return;
    }
    if (event) {
        event.preventDefault();
        event.stopPropagation();
    }
    
    // Update navigation active states
    elements.navItems.forEach(n => n.classList.remove('active'));
    const unsubNavItem = document.getElementById('nav-unsubscribe');
    if (unsubNavItem) unsubNavItem.classList.add('active');
    
    // Hide standard 3 columns
    document.getElementById('senders-pane').style.display = 'none';
    document.getElementById('emails-pane').style.display = 'none';
    document.getElementById('reader-pane').style.display = 'none';
    
    // Hide other tool views
    if (elements.bulkDeleteView) elements.bulkDeleteView.style.display = 'none';
    if (elements.archivesView) elements.archivesView.style.display = 'none';
    
    // Show tool pane
    const toolPane = document.getElementById('tool-view');
    toolPane.style.display = 'flex';
    
    // Load existing unsubscribe list
    await loadUnsubscribeList();
}

async function loadUnsubscribeList(selectNewPage = false) {
    try {
        const res = await apiFetch('/api/unsubscribe/links');
        const data = await res.json();
        
        unsubState.list = data.unsubscribe_list || [];
        unsubState.remainingCount = data.remaining_count || 0;
        
        // Update header scan button text with remaining count
        if (elements.scanUnsubBtn) {
            elements.scanUnsubBtn.disabled = unsubState.remainingCount === 0;
            const btnSpan = elements.scanUnsubBtn.querySelector('span');
            if (btnSpan) {
                btnSpan.textContent = unsubState.remainingCount > 0 ? `Scan & Extract (${unsubState.remainingCount} left)` : 'All Scanned';
            }
        }
        
        // Calculate total pages
        const totalPages = Math.ceil(unsubState.list.length / unsubState.pageSize);
        
        if (selectNewPage && totalPages > 0) {
            unsubState.currentPage = totalPages; // Select the newly created page
        } else if (unsubState.currentPage > totalPages) {
            unsubState.currentPage = Math.max(1, totalPages);
        }
        
        renderUnsubscribeTable(unsubState.list);
        renderPagination(totalPages);
    } catch (err) {
        console.error("Failed to load unsubscribe links", err);
    }
}

async function runUnsubscribeScan() {
    const scanBtnText = elements.scanUnsubBtn.innerHTML;
    const startBtnText = elements.startScanBtn.innerHTML;
    
    try {
        elements.scanUnsubBtn.disabled = true;
        elements.startScanBtn.disabled = true;
        elements.scanUnsubBtn.innerHTML = `<i data-lucide="loader-2" class="spinner-small" style="margin-right:6px"></i> Scanning...`;
        elements.startScanBtn.innerHTML = `<i data-lucide="loader-2" class="spinner-small" style="margin-right:6px"></i> Running Scan...`;
        lucide.createIcons();
        
        const res = await apiFetch('/api/unsubscribe/scan', { method: 'POST' });
        const data = await res.json();
        
        await showAppAlert("Scan Complete", data.message || "Scan complete!", "success");
        
        // Reload list and jump to the new page
        await loadUnsubscribeList(true);
    } catch (err) {
        console.error("Unsubscribe scan failed", err);
        await showAppAlert("Scan Failed", "Scan failed. Check server console.", "warning");
    } finally {
        elements.scanUnsubBtn.disabled = false;
        elements.startScanBtn.disabled = false;
        elements.scanUnsubBtn.innerHTML = scanBtnText;
        elements.startScanBtn.innerHTML = startBtnText;
        lucide.createIcons();
    }
}

async function runExtractNextScan() {
    const btn = document.getElementById('unsub-extract-next-btn');
    const originalHTML = btn ? btn.innerHTML : '';
    
    if (btn) {
        btn.disabled = true;
        btn.innerHTML = `<i data-lucide="loader-2" class="spinner-small"></i> <span>Extracting Next 100...</span>`;
        lucide.createIcons();
    }
    
    if (elements.scanUnsubBtn) {
        elements.scanUnsubBtn.disabled = true;
    }
    
    try {
        const res = await apiFetch('/api/unsubscribe/scan', { method: 'POST' });
        const data = await res.json();
        
        // Reload list and automatically jump to the newly added page
        await loadUnsubscribeList(true);
        
        await showAppAlert("Extraction Complete", data.message || "Extraction complete!", "success");
    } catch (err) {
        console.error("Extraction scan failed", err);
        await showAppAlert("Extraction Failed", "Extraction failed. Check server console.", "warning");
        if (btn) {
            btn.innerHTML = originalHTML;
            btn.disabled = false;
            lucide.createIcons();
        }
    } finally {
        if (elements.scanUnsubBtn) {
            elements.scanUnsubBtn.disabled = false;
        }
    }
}

function renderUnsubscribeTable(list) {
    if (list.length === 0) {
        elements.unsubPlaceholder.style.display = 'flex';
        elements.unsubTableContainer.style.display = 'none';
        return;
    }
    
    elements.unsubPlaceholder.style.display = 'none';
    elements.unsubTableContainer.style.display = 'block';
    
    // Slice list based on current page
    const start = (unsubState.currentPage - 1) * unsubState.pageSize;
    const end = start + unsubState.pageSize;
    const paginatedList = list.slice(start, end);
    
    elements.unsubTableBody.innerHTML = paginatedList.map((item, index) => {
        const isMailto = item.unsubscribe_link.startsWith('mailto:');
        const cleanLink = isMailto ? item.unsubscribe_link : item.unsubscribe_link;
        
        const isDone = item.unsub_status === 'unsubscribed';
        const isInitiated = item.unsub_status === 'initiated';
        
        let btnClass = isMailto ? 'unsub-btn mailto' : 'unsub-btn';
        let btnLabel = isMailto ? '📧 Email Unsub' : '🔗 Unsubscribe';
        let icon = isMailto ? 'mail' : 'external-link';
        
        if (isInitiated) {
            btnClass += ' initiated';
            btnLabel = isMailto ? 'Email Drafted' : 'Opened Link';
        }
        
        let rowClass = '';
        if (isDone) rowClass = 'row-unsubscribed';
        else if (isInitiated) rowClass = 'row-initiated';
        
        const checkIcon = isDone ? 'check-circle' : 'circle';
        const checkLabel = isDone ? 'Unsubscribed' : 'Mark Unsubscribed';
        const checkBtnClass = isDone ? 'action-check-btn unsubscribed' : 'action-check-btn';
        
        const rowNumber = start + index + 1;
        
        return `
            <tr class="${rowClass}">
                <td style="text-align: center; color: var(--text-secondary); font-weight: 600; font-size: 12px; width: 50px;">${rowNumber}</td>
                <td><strong>${item.sender_name}</strong></td>
                <td><code style="font-size:12px; color:var(--text-secondary);">${item.sender_email}</code></td>
                <td style="text-align: center;">
                    <span class="sender-count-badge ${item.unread_count > 0 ? 'unread' : ''}" style="display:inline-block;">
                        ${item.unread_count}/${item.total_count}
                    </span>
                </td>
                <td><span class="latest-subject-span" title="${item.latest_subject}">${item.latest_subject}</span></td>
                <td style="text-align: right; white-space: nowrap; gap: 8px;">
                    <button class="${checkBtnClass}" onclick="toggleLocalUnsub('${item.sender_email}', !${isDone}, this)" style="margin-right: 8px;">
                        <i data-lucide="${checkIcon}" style="width:13px; height:13px;"></i>
                        <span>${checkLabel}</span>
                    </button>
                    <a href="${cleanLink}" target="_blank" class="${btnClass}" onclick="markInitiated('${item.sender_email}', this)">
                        <i data-lucide="${icon}" style="width:13px; height:13px;"></i>
                        <span>${btnLabel}</span>
                    </a>
                </td>
            </tr>
        `;
    }).join('');
    
    lucide.createIcons();
}

function renderPagination(totalPages) {
    const controls = document.getElementById('unsub-header-controls');
    
    if (!controls) return;
    
    // Clear header controls
    controls.innerHTML = '';
    
    // 1. Render page number buttons
    if (totalPages > 1) {
        const pagesContainer = document.createElement('div');
        pagesContainer.style.display = 'flex';
        pagesContainer.style.gap = '6px';
        
        for (let i = 1; i <= totalPages; i++) {
            const activeClass = i === unsubState.currentPage ? 'active' : '';
            const btn = document.createElement('button');
            btn.className = `page-num-btn ${activeClass}`;
            btn.textContent = i;
            btn.onclick = () => {
                unsubState.currentPage = i;
                renderUnsubscribeTable(unsubState.list);
                renderPagination(totalPages);
            };
            pagesContainer.appendChild(btn);
        }
        controls.appendChild(pagesContainer);
    }
    
    // 2. Render Extract Next button on the right
    if (unsubState.remainingCount > 0) {
        const extractBtn = document.createElement('button');
        extractBtn.id = 'unsub-extract-next-btn';
        extractBtn.className = 'extract-next-btn';
        extractBtn.innerHTML = `<i data-lucide="sparkles" style="width:13px; height:13px;"></i> <span>Extract Next 100 (${unsubState.remainingCount} left)</span>`;
        extractBtn.onclick = runExtractNextScan;
        controls.appendChild(extractBtn);
        lucide.createIcons();
    }
}

async function toggleLocalUnsub(senderEmail, status, btnElement) {
    try {
        btnElement.disabled = true;
        const apiStatus = status ? 'unsubscribed' : 'none';
        const res = await apiFetch('/api/unsubscribe/toggle', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ sender_email: senderEmail, status: apiStatus })
        });
        const data = await res.json();
        if (data.success) {
            const row = btnElement.closest('tr');
            if (row) {
                if (status) {
                    row.classList.remove('row-initiated');
                    row.classList.add('row-unsubscribed');
                    btnElement.classList.add('unsubscribed');
                    btnElement.innerHTML = `<i data-lucide="check-circle" style="width:13px; height:13px;"></i> <span>Unsubscribed</span>`;
                    
                    const unsubBtn = row.querySelector('.unsub-btn');
                    if (unsubBtn) {
                        unsubBtn.classList.remove('initiated');
                        const isMailto = unsubBtn.classList.contains('mailto');
                        unsubBtn.querySelector('span').textContent = isMailto ? '📧 Email Unsub' : '🔗 Unsubscribe';
                    }
                } else {
                    row.classList.remove('row-unsubscribed');
                    row.classList.remove('row-initiated');
                    btnElement.classList.remove('unsubscribed');
                    btnElement.innerHTML = `<i data-lucide="circle" style="width:13px; height:13px;"></i> <span>Mark Unsubscribed</span>`;
                }
                lucide.createIcons();
            }
            btnElement.setAttribute('onclick', `toggleLocalUnsub('${senderEmail}', ${!status}, this)`);
        }
    } catch (err) {
        console.error("Failed to toggle local unsubscribe status", err);
    } finally {
        btnElement.disabled = false;
    }
}

async function markInitiated(senderEmail, element) {
    const row = element.closest('tr');
    if (row && row.classList.contains('row-unsubscribed')) {
        return;
    }
    
    if (row) {
        row.classList.add('row-initiated');
    }
    element.classList.add('initiated');
    const span = element.querySelector('span');
    if (span) {
        if (element.classList.contains('mailto')) {
            span.textContent = 'Email Drafted';
        } else {
            span.textContent = 'Opened Link';
        }
    }
    
    try {
        await apiFetch('/api/unsubscribe/toggle', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ sender_email: senderEmail, status: 'initiated' })
        });
    } catch (err) {
        console.error("Failed to persist initiated status", err);
    }
}

async function openBulkDeleteTool(event) {
    if (state.isDeleting) {
        await showAppAlert("Navigation Locked", "Please wait until the active deletion process completes.", "warning");
        if (event) event.preventDefault();
        return;
    }
    if (event) event.preventDefault();
    
    // Manage active nav item highlight
    elements.navItems.forEach(n => n.classList.remove('active'));
    const unsubNavItem = document.getElementById('nav-unsubscribe');
    if (unsubNavItem) unsubNavItem.classList.remove('active');
    const archivesNavItem = document.getElementById('nav-archives');
    if (archivesNavItem) archivesNavItem.classList.remove('active');
    
    const deleteNavItem = document.getElementById('nav-bulk-delete');
    if (deleteNavItem) deleteNavItem.classList.add('active');
    
    // Hide standard 3 columns
    document.getElementById('senders-pane').style.display = 'none';
    document.getElementById('emails-pane').style.display = 'none';
    document.getElementById('reader-pane').style.display = 'none';
    
    // Hide other tool views
    document.getElementById('tool-view').style.display = 'none';
    if (elements.archivesView) elements.archivesView.style.display = 'none';
    
    // Show bulk delete pane
    if (elements.bulkDeleteView) {
        elements.bulkDeleteView.style.display = 'flex';
        await loadDeleteQueue();
    }
}

async function loadDeleteQueue() {
    try {
        const res = await apiFetch('/api/delete-queue');
        const data = await res.json();
        bulkDeleteState.list = data.delete_queue || [];
        filterAndRenderDeleteQueue();
    } catch (err) {
        console.error("Failed to load delete queue", err);
    }
}

function filterAndRenderDeleteQueue() {
    const tab = bulkDeleteState.activeTab;
    let filteredList = [];
    
    if (tab === 'queue') {
        filteredList = bulkDeleteState.list.filter(item => item.status === 'pending' || item.status === 'processing');
        if (elements.startBulkDeleteBtn) {
            elements.startBulkDeleteBtn.style.display = 'inline-flex';
            elements.startBulkDeleteBtn.disabled = filteredList.length === 0;
        }
        const keepBackupLbl = document.querySelector('.backup-checkbox-label');
        if (keepBackupLbl) keepBackupLbl.style.display = 'flex';
    } else {
        filteredList = bulkDeleteState.list.filter(item => item.status === 'completed');
        if (elements.startBulkDeleteBtn) {
            elements.startBulkDeleteBtn.style.display = 'none';
        }
        const keepBackupLbl = document.querySelector('.backup-checkbox-label');
        if (keepBackupLbl) keepBackupLbl.style.display = 'none';
    }
    
    renderDeleteQueueTable(filteredList);
}

function renderDeleteQueueTable(list) {
    if (!elements.bulkDeletePlaceholder || !elements.bulkDeleteTableContainer || !elements.bulkDeleteTableBody) return;
    
    if (list.length === 0) {
        elements.bulkDeletePlaceholder.style.display = 'flex';
        elements.bulkDeleteTableContainer.style.display = 'none';
        
        // Dynamically update placeholder messages based on active tab
        const plTitle = elements.bulkDeletePlaceholder.querySelector('h3');
        const plDesc = elements.bulkDeletePlaceholder.querySelector('p');
        const plArt = elements.bulkDeletePlaceholder.querySelector('.placeholder-art');
        
        if (bulkDeleteState.activeTab === 'queue') {
            if (plTitle) plTitle.textContent = 'No Senders Queued';
            if (plDesc) plDesc.textContent = 'Select any sender from your mail list and click Queue for Delete to add them here. Once added, you can bulk delete all of their emails from Gmail with a single click.';
            if (plArt) {
                plArt.style.color = '#ef4444';
                plArt.style.background = 'hsla(0, 80%, 50%, 0.08)';
                plArt.style.borderColor = 'hsla(0, 80%, 50%, 0.15)';
                plArt.innerHTML = '<i data-lucide="trash-2"></i>';
            }
        } else {
            if (plTitle) plTitle.textContent = 'No Deleted Senders';
            if (plDesc) plDesc.textContent = 'History of senders you bulk delete from Gmail will be displayed here. You can download their local ZIP backups if saved.';
            if (plArt) {
                plArt.style.color = '#10b981';
                plArt.style.background = 'hsla(145, 80%, 40%, 0.08)';
                plArt.style.borderColor = 'hsla(145, 80%, 40%, 0.15)';
                plArt.innerHTML = '<i data-lucide="archive"></i>';
            }
        }
        lucide.createIcons();
        return;
    }
    
    elements.bulkDeletePlaceholder.style.display = 'none';
    elements.bulkDeleteTableContainer.style.display = 'block';
    
    elements.bulkDeleteTableBody.innerHTML = list.map((item, index) => {
        let statusClass = 'pending';
        let statusLabel = 'Pending Deletion';
        
        if (item.status === 'processing') {
            statusClass = 'processing';
            statusLabel = `
                <div style="display: inline-flex; align-items: center; gap: 8px; vertical-align: middle;">
                    <div class="spinner-small" style="margin: 0; width: 12px; height: 12px; border-color: rgba(245, 158, 11, 0.15); border-top-color: #f59e0b;"></div>
                    <span>Processing...</span>
                </div>
            `;
        } else if (item.status === 'completed') {
            statusClass = 'completed';
            statusLabel = 'Deleted';
        } else if (item.status === 'failed') {
            statusClass = 'failed';
            statusLabel = 'Failed';
        }
        
        // Define action button based on tab
        let actionButtonHtml = '';
        if (bulkDeleteState.activeTab === 'queue') {
            actionButtonHtml = `
                <button class="action-check-btn" onclick="removeFromDeleteQueue('${item.sender_email}', this)" style="border-color: hsla(0, 80%, 60%, 0.2); color: #ef4444;">
                    <i data-lucide="trash-2" style="width:13px; height:13px;"></i>
                    <span>Remove</span>
                </button>
            `;
        } else {
            if (item.has_backup) {
                actionButtonHtml = `
                    <a href="/api/archives/download/${encodeURIComponent(item.sender_email + '_archive.zip')}" class="action-check-btn" style="border-color: rgba(59, 130, 246, 0.2); color: #3b82f6; text-decoration: none;">
                        <i data-lucide="download" style="width:13px; height:13px;"></i>
                        <span>Download ZIP</span>
                    </a>
                `;
            } else {
                actionButtonHtml = `
                    <span style="font-size: 11px; color: var(--text-muted); font-weight: 500;">
                        No Backup Saved
                    </span>
                `;
            }
        }
        
        return `
            <tr>
                <td style="text-align: center; color: var(--text-secondary); font-weight: 600; font-size: 12px; width: 50px;">${index + 1}</td>
                <td><strong>${item.sender_name}</strong></td>
                <td><code style="font-size:12px; color:var(--text-secondary);">${item.sender_email}</code></td>
                <td style="text-align: center;">
                    <span class="sender-count-badge" style="display:inline-block; background: var(--bg-pane-alt);">
                        ${item.total_count} emails
                    </span>
                </td>
                <td style="text-align: center;">
                    <span class="status-badge ${statusClass}">${statusLabel}</span>
                </td>
                <td style="text-align: right;">
                    ${actionButtonHtml}
                </td>
            </tr>
        `;
    }).join('');
    
    lucide.createIcons();
}

function switchDeleteTab(tab) {
    bulkDeleteState.activeTab = tab;
    
    const queueBtn = document.getElementById('tab-delete-queue');
    const historyBtn = document.getElementById('tab-delete-history');
    
    if (tab === 'queue') {
        if (queueBtn) queueBtn.classList.add('active');
        if (historyBtn) historyBtn.classList.remove('active');
    } else {
        if (queueBtn) queueBtn.classList.remove('active');
        if (historyBtn) historyBtn.classList.add('active');
    }
    
    filterAndRenderDeleteQueue();
}

async function removeFromDeleteQueue(senderEmail, btn) {
    try {
        if (btn) btn.disabled = true;
        const res = await apiFetch('/api/delete-queue/remove', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ sender_email: senderEmail })
        });
        const data = await res.json();
        if (data.success) {
            // Reload list
            await loadDeleteQueue();
            // If the deleted sender was currently selected, refresh button state
            if (state.selectedSender && state.selectedSender.email === senderEmail) {
                updateQueueDeleteButtonState(false);
            }
        }
    } catch (err) {
        console.error("Failed to remove from delete queue", err);
    }
}

function showAppConfirm(title, message) {
    return new Promise((resolve) => {
        const modal = document.getElementById('app-confirm-modal');
        const titleEl = document.getElementById('confirm-modal-title');
        const msgEl = document.getElementById('confirm-modal-message');
        const cancelBtn = document.getElementById('confirm-modal-cancel');
        const submitBtn = document.getElementById('confirm-modal-submit');
        const headerEl = modal ? modal.querySelector('.modal-header') : null;
        
        if (!modal || !cancelBtn || !submitBtn || !headerEl) {
            resolve(confirm(message));
            return;
        }
        
        // Reset modal styling for Confirm dialog
        cancelBtn.style.display = 'inline-flex';
        cancelBtn.textContent = 'Cancel';
        
        submitBtn.className = 'danger-btn';
        submitBtn.style.background = '#ef4444';
        submitBtn.style.color = 'white';
        submitBtn.style.borderColor = 'transparent';
        submitBtn.innerHTML = '<span>Delete Threads</span>';
        
        const existingIcon = headerEl.querySelector('.modal-icon');
        if (existingIcon) existingIcon.remove();
        headerEl.insertAdjacentHTML('afterbegin', '<i data-lucide="alert-triangle" class="modal-icon warning" style="color: #ef4444; width:20px; height:20px;"></i>');
        
        titleEl.textContent = title;
        msgEl.textContent = message;
        
        modal.style.display = 'flex';
        lucide.createIcons();
        
        const cleanup = (value) => {
            modal.style.display = 'none';
            cancelBtn.removeEventListener('click', onCancel);
            submitBtn.removeEventListener('click', onSubmit);
            resolve(value);
        };
        
        const onCancel = () => cleanup(false);
        const onSubmit = () => cleanup(true);
        
        cancelBtn.addEventListener('click', onCancel);
        submitBtn.addEventListener('click', onSubmit);
    });
}

function showAppAlert(title, message, type = 'info') {
    return new Promise((resolve) => {
        const modal = document.getElementById('app-confirm-modal');
        const titleEl = document.getElementById('confirm-modal-title');
        const msgEl = document.getElementById('confirm-modal-message');
        const cancelBtn = document.getElementById('confirm-modal-cancel');
        const submitBtn = document.getElementById('confirm-modal-submit');
        const headerEl = modal ? modal.querySelector('.modal-header') : null;
        
        if (!modal || !cancelBtn || !submitBtn || !headerEl) {
            alert(message);
            resolve();
            return;
        }
        
        // Hide cancel button for Alert mode
        cancelBtn.style.display = 'none';
        
        // Set content
        titleEl.textContent = title;
        msgEl.textContent = message;
        
        // Configure styles based on alert type
        const existingIcon = headerEl.querySelector('.modal-icon');
        if (existingIcon) existingIcon.remove();
        
        let iconHtml = '';
        if (type === 'success') {
            iconHtml = '<i data-lucide="check-circle" class="modal-icon" style="color: #10b981; width:20px; height:20px;"></i>';
            submitBtn.className = 'action-check-btn';
            submitBtn.style.background = '#10b981';
            submitBtn.style.color = 'white';
            submitBtn.style.borderColor = 'transparent';
        } else if (type === 'warning') {
            iconHtml = '<i data-lucide="alert-triangle" class="modal-icon" style="color: #ef4444; width:20px; height:20px;"></i>';
            submitBtn.className = 'danger-btn';
            submitBtn.style.background = '#ef4444';
            submitBtn.style.color = 'white';
            submitBtn.style.borderColor = 'transparent';
        } else {
            iconHtml = '<i data-lucide="info" class="modal-icon" style="color: #3b82f6; width:20px; height:20px;"></i>';
            submitBtn.className = 'action-check-btn';
            submitBtn.style.background = '#3b82f6';
            submitBtn.style.color = 'white';
            submitBtn.style.borderColor = 'transparent';
        }
        
        headerEl.insertAdjacentHTML('afterbegin', iconHtml);
        submitBtn.innerHTML = '<span>OK</span>';
        
        modal.style.display = 'flex';
        lucide.createIcons();
        
        const cleanup = () => {
            modal.style.display = 'none';
            submitBtn.removeEventListener('click', onSubmit);
            resolve();
        };
        
        const onSubmit = () => cleanup();
        submitBtn.addEventListener('click', onSubmit);
    });
}

async function runBulkDelete() {
    const pendingSenders = bulkDeleteState.list.filter(item => item.status === 'pending' || item.status === 'processing');
    if (pendingSenders.length === 0) {
        await showAppAlert("Queue Empty", "No pending senders to delete.", "info");
        return;
    }
    
    const confirmed = await showAppConfirm(
        "Confirm Deletion",
        `Are you sure you want to delete all emails from these ${pendingSenders.length} senders on Gmail? This action cannot be easily undone.`
    );
    if (!confirmed) return;
    
    const originalHTML = elements.startBulkDeleteBtn.innerHTML;
    const keepLocal = elements.keepBackupCheckbox ? elements.keepBackupCheckbox.checked : false;
    
    // Toggle navigation lock
    state.isDeleting = true;
    
    // Initialize Progress Container elements
    const progressContainer = document.getElementById('delete-progress-container');
    const progressBar = document.getElementById('delete-progress-bar');
    const progressTitle = document.getElementById('delete-progress-title');
    const progressNumber = document.getElementById('delete-progress-number');
    const progressDetails = document.getElementById('delete-progress-details');
    
    if (progressContainer) {
        progressContainer.style.display = 'flex';
        progressBar.style.width = '0%';
        progressTitle.textContent = 'Deleting email threads...';
        progressNumber.textContent = `0 / ${pendingSenders.length} senders`;
        progressDetails.textContent = 'Initializing backup & trash batch execution...';
    }
    
    try {
        elements.startBulkDeleteBtn.disabled = true;
        elements.startBulkDeleteBtn.innerHTML = `<i data-lucide="loader-2" class="spinner-small"></i> <span>Deleting...</span>`;
        if (elements.keepBackupCheckbox) elements.keepBackupCheckbox.disabled = true;
        lucide.createIcons();
        
        let totalEmailsProcessed = 0;
        
        for (let i = 0; i < pendingSenders.length; i++) {
            const sender = pendingSenders[i];
            
            // 1. Update progress state in UI for this specific sender
            const itemInList = bulkDeleteState.list.find(s => s.sender_email === sender.sender_email);
            if (itemInList) itemInList.status = 'processing';
            filterAndRenderDeleteQueue();
            
            if (progressDetails) {
                progressDetails.textContent = `Processing ${sender.sender_name || sender.sender_email} (${sender.sender_email}) - ${sender.total_count} emails...`;
            }
            
            // 2. Call execute API for this specific sender
            const res = await apiFetch('/api/delete-queue/execute', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ keep_local_backup: keepLocal, sender_email: sender.sender_email })
            });
            const data = await res.json();
            
            if (data.error) {
                if (itemInList) itemInList.status = 'failed';
                console.error(`Deletion failed for ${sender.sender_email}: ${data.error}`);
            } else {
                if (itemInList) itemInList.status = 'completed';
                totalEmailsProcessed += sender.total_count;
            }
            
            // 3. Update Progress Bar
            const percent = Math.round(((i + 1) / pendingSenders.length) * 100);
            if (progressBar) progressBar.style.width = `${percent}%`;
            if (progressNumber) progressNumber.textContent = `${i + 1} / ${pendingSenders.length} senders`;
            
            // Re-render table to show updated status row
            filterAndRenderDeleteQueue();
        }
        
        // Final completion state
        if (progressTitle) progressTitle.textContent = 'Deletion Complete!';
        if (progressDetails) {
            const backupText = keepLocal ? "locally archived as ZIPs" : "completely purged";
            progressDetails.textContent = `Successfully processed ${pendingSenders.length} senders (${totalEmailsProcessed} emails total). Local backup: ${backupText}.`;
        }
        
        // Refresh full senders list
        await fetchSenders();
        
        // Reset selected sender states if they were deleted
        if (state.selectedSender) {
            const stillExists = state.senders.some(s => s.email === state.selectedSender.email);
            if (!stillExists) {
                state.selectedSender = null;
                elements.selectedSenderName.textContent = 'Select a Sender';
                elements.selectedSenderEmail.textContent = 'Choose from the left column to view messages';
                if (elements.queueDeleteBtn) elements.queueDeleteBtn.style.display = 'none';
                elements.emailsAccordion.style.display = 'none';
                const pl = elements.emailsListContainer.querySelector('.selection-placeholder');
                if (pl) pl.style.display = 'flex';
            } else {
                await selectSender(state.selectedSender.email);
            }
        }
    } catch (err) {
        console.error("Bulk deletion execution failed", err);
        if (progressTitle) progressTitle.textContent = 'Error Occurred';
        if (progressDetails) progressDetails.textContent = `Execution halted due to connection error: ${err.message}`;
        await showAppAlert("Deletion Failed", "Deletion failed. Check console.", "warning");
    } finally {
        state.isDeleting = false;
        elements.startBulkDeleteBtn.disabled = false;
        elements.startBulkDeleteBtn.innerHTML = originalHTML;
        if (elements.keepBackupCheckbox) elements.keepBackupCheckbox.disabled = false;
        lucide.createIcons();
        
        // Reload final queue from server
        await loadDeleteQueue();
    }
}

async function checkSenderQueueStatus(email) {
    try {
        const res = await apiFetch(`/api/delete-queue/status?sender_email=${encodeURIComponent(email)}`);
        const data = await res.json();
        updateQueueDeleteButtonState(data.is_queued);
    } catch (err) {
        console.error("Failed to check queue status", err);
    }
}

function updateQueueDeleteButtonState(isQueued) {
    if (!elements.queueDeleteBtn) return;
    
    if (isQueued) {
        elements.queueDeleteBtn.classList.add('active');
        elements.queueDeleteBtn.innerHTML = `<i data-lucide="check-circle" style="width:14px; height:14px;"></i> <span>Queued for Delete</span>`;
    } else {
        elements.queueDeleteBtn.classList.remove('active');
        elements.queueDeleteBtn.innerHTML = `<i data-lucide="trash-2" style="width:14px; height:14px;"></i> <span>Queue for Delete</span>`;
    }
    lucide.createIcons();
}

async function openArchivesTool(event) {
    if (state.isDeleting) {
        await showAppAlert("Navigation Locked", "Please wait until the active deletion process completes.", "warning");
        if (event) event.preventDefault();
        return;
    }
    if (event) event.preventDefault();
    
    // Manage active nav item highlight
    elements.navItems.forEach(n => n.classList.remove('active'));
    const unsubNavItem = document.getElementById('nav-unsubscribe');
    if (unsubNavItem) unsubNavItem.classList.remove('active');
    const deleteNavItem = document.getElementById('nav-bulk-delete');
    if (deleteNavItem) deleteNavItem.classList.remove('active');
    
    if (elements.navArchives) elements.navArchives.classList.add('active');
    
    // Hide standard 3 columns
    document.getElementById('senders-pane').style.display = 'none';
    document.getElementById('emails-pane').style.display = 'none';
    document.getElementById('reader-pane').style.display = 'none';
    
    // Hide unsubscribe & bulk delete tool
    elements.unsubPlaceholder.style.display = 'none';
    elements.unsubTableContainer.style.display = 'none';
    document.getElementById('tool-view').style.display = 'none';
    if (elements.bulkDeleteView) elements.bulkDeleteView.style.display = 'none';
    
    // Show archives view
    if (elements.archivesView) {
        elements.archivesView.style.display = 'flex';
        await loadArchivesList();
    }
}

async function loadArchivesList() {
    try {
        const res = await apiFetch('/api/archives');
        const data = await res.json();
        renderArchivesTable(data.archives || []);
    } catch (err) {
        console.error("Failed to load archives list", err);
    }
}

function renderArchivesTable(list) {
    if (!elements.archivesPlaceholder || !elements.archivesTableContainer || !elements.archivesTableBody) return;
    
    if (list.length === 0) {
        elements.archivesPlaceholder.style.display = 'flex';
        elements.archivesTableContainer.style.display = 'none';
        return;
    }
    
    elements.archivesPlaceholder.style.display = 'none';
    elements.archivesTableContainer.style.display = 'block';
    
    elements.archivesTableBody.innerHTML = list.map((item, index) => {
        const formattedDate = formatDateFull(item.created_at * 1000); // timestamp to ms
        const formattedSize = formatBytes(item.size_bytes);
        
        return `
            <tr>
                <td style="text-align: center; color: var(--text-secondary); font-weight: 600; font-size: 12px; width: 50px;">${index + 1}</td>
                <td>
                    <div style="font-weight: 600; color: var(--text-primary); display: flex; align-items: center; gap: 8px;">
                        <i data-lucide="file-archive" style="width: 16px; height: 16px; color: #3b82f6;"></i>
                        <span>${item.sender_email}_archive.zip</span>
                    </div>
                </td>
                <td style="text-align: center;">
                    <span class="sender-count-badge" style="display:inline-block; background: var(--bg-pane-alt);">
                        ${formattedSize}
                    </span>
                </td>
                <td style="text-align: center; color: var(--text-secondary); font-size: 12px;">
                    ${formattedDate}
                </td>
                <td style="text-align: right;">
                    <a href="/api/archives/download/${encodeURIComponent(item.filename)}" class="action-check-btn" style="border-color: rgba(59, 130, 246, 0.2); color: #3b82f6; text-decoration: none;">
                        <i data-lucide="download" style="width:13px; height:13px;"></i>
                        <span>Download ZIP</span>
                    </a>
                </td>
            </tr>
        `;
    }).join('');
    
    lucide.createIcons();
}

function formatBytes(bytes) {
    if (bytes === 0) return '0 Bytes';
    const k = 1024;
    const sizes = ['Bytes', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

async function handleRouting() {
    // 1. Navigation Guard
    if (state.isDeleting && window.location.hash !== state.activeHash) {
        await showAppAlert("Navigation Locked", "Please wait until the active deletion process completes.", "warning");
        window.removeEventListener('hashchange', handleRouting);
        window.location.hash = state.activeHash;
        setTimeout(() => {
            window.addEventListener('hashchange', handleRouting);
        }, 0);
        return;
    }
    
    // 2. Save active hash
    state.activeHash = window.location.hash;
    const hash = window.location.hash;
    
    // 3. Category matching (e.g. #/category/all)
    const catMatch = hash.match(/^#\/category\/(.+)$/);
    if (catMatch) {
        const category = catMatch[1];
        state.currentCategory = category;
        
        // Update sidebar navigation active highlight
        elements.navItems.forEach(n => {
            if (n.getAttribute('data-category') === category) {
                n.classList.add('active');
            } else {
                n.classList.remove('active');
            }
        });
        
        // Remove tools navigation highlight
        const unsubNavItem = document.getElementById('nav-unsubscribe');
        if (unsubNavItem) unsubNavItem.classList.remove('active');
        const deleteNavItem = document.getElementById('nav-bulk-delete');
        if (deleteNavItem) deleteNavItem.classList.remove('active');
        const archivesNavItem = document.getElementById('nav-archives');
        if (archivesNavItem) archivesNavItem.classList.remove('active');
        
        // Restore normal 3 columns
        document.getElementById('senders-pane').style.display = 'flex';
        document.getElementById('emails-pane').style.display = 'flex';
        document.getElementById('reader-pane').style.display = 'flex';
        
        // Hide all tool views
        document.getElementById('tool-view').style.display = 'none';
        if (elements.bulkDeleteView) elements.bulkDeleteView.style.display = 'none';
        if (elements.archivesView) elements.archivesView.style.display = 'none';
        
        await fetchSenders();
        return;
    }
    
    // 4. Tools matching
    if (hash === '#/tools/unsubscribe') {
        elements.navItems.forEach(n => n.classList.remove('active'));
        const unsubNavItem = document.getElementById('nav-unsubscribe');
        if (unsubNavItem) unsubNavItem.classList.add('active');
        const deleteNavItem = document.getElementById('nav-bulk-delete');
        if (deleteNavItem) deleteNavItem.classList.remove('active');
        const archivesNavItem = document.getElementById('nav-archives');
        if (archivesNavItem) archivesNavItem.classList.remove('active');
        
        document.getElementById('senders-pane').style.display = 'none';
        document.getElementById('emails-pane').style.display = 'none';
        document.getElementById('reader-pane').style.display = 'none';
        
        if (elements.bulkDeleteView) elements.bulkDeleteView.style.display = 'none';
        if (elements.archivesView) elements.archivesView.style.display = 'none';
        
        document.getElementById('tool-view').style.display = 'flex';
        await loadUnsubscribeList();
        return;
    }
    
    if (hash === '#/tools/bulk-delete') {
        elements.navItems.forEach(n => n.classList.remove('active'));
        const unsubNavItem = document.getElementById('nav-unsubscribe');
        if (unsubNavItem) unsubNavItem.classList.remove('active');
        const deleteNavItem = document.getElementById('nav-bulk-delete');
        if (deleteNavItem) deleteNavItem.classList.add('active');
        const archivesNavItem = document.getElementById('nav-archives');
        if (archivesNavItem) archivesNavItem.classList.remove('active');
        
        document.getElementById('senders-pane').style.display = 'none';
        document.getElementById('emails-pane').style.display = 'none';
        document.getElementById('reader-pane').style.display = 'none';
        
        document.getElementById('tool-view').style.display = 'none';
        if (elements.archivesView) elements.archivesView.style.display = 'none';
        
        if (elements.bulkDeleteView) {
            elements.bulkDeleteView.style.display = 'flex';
            await loadDeleteQueue();
        }
        return;
    }
    
    if (hash === '#/tools/archives') {
        elements.navItems.forEach(n => n.classList.remove('active'));
        const unsubNavItem = document.getElementById('nav-unsubscribe');
        if (unsubNavItem) unsubNavItem.classList.remove('active');
        const deleteNavItem = document.getElementById('nav-bulk-delete');
        if (deleteNavItem) deleteNavItem.classList.remove('active');
        const archivesNavItem = document.getElementById('nav-archives');
        if (archivesNavItem) archivesNavItem.classList.add('active');
        
        document.getElementById('senders-pane').style.display = 'none';
        document.getElementById('emails-pane').style.display = 'none';
        document.getElementById('reader-pane').style.display = 'none';
        
        document.getElementById('tool-view').style.display = 'none';
        if (elements.bulkDeleteView) elements.bulkDeleteView.style.display = 'none';
        
        if (elements.archivesView) {
            elements.archivesView.style.display = 'flex';
            await loadArchivesList();
        }
        return;
    }
    
    // 5. Default fallback to categories/all
    window.location.hash = '#/category/all';
}

async function linkGoogleAccount(event) {
    if (event) event.preventDefault();
    
    elements.accountStatus.innerHTML = `
        <div class="account-loader" style="display: flex; align-items: center; gap: 10px;">
            <div class="spinner-small"></div>
            <span style="font-size: 12px;">Linking... Check browser popup</span>
        </div>
    `;
    
    try {
        const response = await apiFetch('/api/auth/link', { method: 'POST' });
        const data = await response.json();
        
        if (data.success) {
            await showAppAlert("Google Account Linked", `Successfully authenticated ${data.email}! Starting local cache sync...`, "success");
            window.location.reload();
        } else {
            await showAppAlert("Link Failed", data.error || "Failed to link Google account.", "warning");
            await checkStatus();
        }
    } catch (err) {
        console.error("Link account error:", err);
        await showAppAlert("Connection Error", "Failed to communicate with authorization server.", "warning");
        await checkStatus();
    }
}

async function unlinkGoogleAccount(event) {
    if (event) event.preventDefault();
    
    const confirmed = await showAppConfirm(
        "Unlink Account?",
        "Are you sure you want to unlink your Google account? This will stop inbox synchronization and log you out."
    );
    if (!confirmed) return;
    
    try {
        const response = await apiFetch('/api/auth/unlink', { method: 'POST' });
        const data = await response.json();
        
        if (data.success) {
            await showAppAlert("Unlinked", "Google account unlinked successfully.", "success");
            window.location.reload();
        } else {
            await showAppAlert("Failed", data.error || "Failed to unlink Google account.", "warning");
        }
    } catch (err) {
        console.error("Unlink error:", err);
        await showAppAlert("Connection Error", "Failed to communicate with unlinking server.", "warning");
    }
}

async function handleCredentialsUpload(event) {
    const file = event.target.files[0];
    if (!file) return;
    
    if (!file.name.endsWith('.json')) {
        await showAppAlert("Invalid File", "Please upload a valid JSON credentials file.", "warning");
        return;
    }
    
    elements.accountStatus.innerHTML = `
        <div class="account-loader" style="display: flex; align-items: center; gap: 10px;">
            <div class="spinner-small"></div>
            <span style="font-size: 12px;">Uploading credentials...</span>
        </div>
    `;
    
    const formData = new FormData();
    formData.append('file', file);
    
    try {
        const response = await fetch('/api/auth/upload-credentials', {
            method: 'POST',
            headers: {
                'X-API-Token': apiToken
            },
            body: formData
        });
        const data = await response.json();
        
        if (data.success) {
            await showAppAlert("Upload Success", "credentials.json uploaded successfully! You can now link your Google Account.", "success");
        } else {
            await showAppAlert("Upload Failed", data.error || "Failed to upload file.", "warning");
        }
    } catch (err) {
        console.error("Upload error:", err);
        await showAppAlert("Connection Error", "Failed to upload file to the server.", "warning");
    } finally {
        await checkStatus();
    }
}

function toggleProfileSwitcher(event) {
    if (event) event.stopPropagation();
    const menu = document.getElementById('profile-switcher-menu');
    if (!menu) return;
    
    if (menu.style.display === 'none' || menu.style.display === '') {
        menu.style.display = 'flex';
        const closeMenu = (e) => {
            const statusCard = document.getElementById('account-status');
            if (menu && !menu.contains(e.target) && statusCard && !statusCard.contains(e.target)) {
                menu.style.display = 'none';
                document.removeEventListener('click', closeMenu);
            }
        };
        document.addEventListener('click', closeMenu);
    } else {
        menu.style.display = 'none';
    }
}

async function switchActiveProfile(email) {
    try {
        const response = await apiFetch('/api/auth/switch', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ email })
        });
        const data = await response.json();
        if (data.success) {
            await showAppAlert("Profile Switched", `Switched active profile to ${email}`, "success");
            window.location.reload();
        } else {
            await showAppAlert("Switch Failed", data.error || "Failed to switch profiles.", "warning");
        }
    } catch (err) {
        console.error("Switch error:", err);
        await showAppAlert("Connection Error", "Failed to switch active profile.", "warning");
    }
}

window.toggleNavSection = toggleNavSection;
window.openUnsubscribeTool = openUnsubscribeTool;
window.openBulkDeleteTool = openBulkDeleteTool;
window.openArchivesTool = openArchivesTool;
window.toggleLocalUnsub = toggleLocalUnsub;
window.markInitiated = markInitiated;
window.removeFromDeleteQueue = removeFromDeleteQueue;
window.switchDeleteTab = switchDeleteTab;
window.runBulkDelete = runBulkDelete;
window.linkGoogleAccount = linkGoogleAccount;
window.unlinkGoogleAccount = unlinkGoogleAccount;
window.handleCredentialsUpload = handleCredentialsUpload;
window.toggleProfileSwitcher = toggleProfileSwitcher;
window.switchActiveProfile = switchActiveProfile;

