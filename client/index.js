// GitHub Data Sync - Frontend Extension for SillyTavern
// Auto-deployed to: public/scripts/extensions/third-party/github-data-sync/index.js
import { SlashCommandParser } from '../../../slash-commands/SlashCommandParser.js';
import { SlashCommand } from '../../../slash-commands/SlashCommand.js';

const API_BASE = '/api/plugins/github-data-sync';

// ===================== API helpers =====================

let _csrfToken = null;

async function getCsrfToken() {
    if (_csrfToken) return _csrfToken;
    try {
        const resp = await fetch('/csrf-token');
        const data = await resp.json();
        _csrfToken = data.token;
        return _csrfToken;
    } catch { return ''; }
}

async function apiCall(method, endpoint, body) {
    const headers = { 'Content-Type': 'application/json' };
    if (method !== 'GET') {
        const token = await getCsrfToken();
        if (token) headers['X-CSRF-Token'] = token;
    }
    const opts = { method, headers };
    if (body) opts.body = JSON.stringify(body);
    const resp = await fetch(`${API_BASE}${endpoint}`, opts);
    const data = await resp.json();
    if (!data.success) {
        throw new Error(data.error || data.errors?.join(', ') || 'Unknown error');
    }
    return data;
}

async function loadConfig() {
    try { const data = await apiCall('GET', '/config'); return data.config || {}; }
    catch { return {}; }
}

async function saveConfig(partial) {
    try { const data = await apiCall('PUT', '/config', partial); return data.config || {}; }
    catch (err) { toastr.error(`Save failed: ${err.message}`, 'GitHub Sync'); return null; }
}

function escapeHtml(str) {
    return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ===================== Sync operations =====================

async function doPush() {
    try {
        toastr.info('Pushing data to GitHub...', 'GitHub Sync');
        const result = await apiCall('POST', '/push');
        if (result.skipped) {
            toastr.warning('No changes to push.', 'GitHub Sync');
        } else {
            const files = result.filesChanged?.join(', ') || '';
            toastr.success('Push OK: ' + files, 'GitHub Sync');
        }
        refreshAllUI();
    } catch (err) {
        toastr.error('Push failed: ' + err.message, 'GitHub Sync');
    }
}

async function doPull() {
    const cfg = await loadConfig();
    if (cfg.pullConfirmation !== false) {
        const confirmed = await showConfirmDialog(
            'Pull from GitHub?',
            'This will overwrite local SillyTavern data with the latest from the repository. Continue?'
        );
        if (!confirmed) return;
    }
    try {
        toastr.info('Pulling data from GitHub...', 'GitHub Sync');
        const result = await apiCall('POST', '/pull');
        if (result.conflicts?.length > 0) {
            toastr.warning('Pull had conflicts in: ' + result.conflicts.join(', '), 'GitHub Sync');
        } else {
            const files = result.filesRestored?.join(', ') || '';
            toastr.success('Pull OK: ' + files, 'GitHub Sync');
        }
        refreshAllUI();
    } catch (err) {
        toastr.error('Pull failed: ' + err.message, 'GitHub Sync');
    }
}

async function doStatus() {
    try {
        const data = await apiCall('GET', '/status');
        let msg = 'GitHub Sync Status\n\n';
        msg += `Auto-push: ${data.autoPushEnabled ? 'ON (every ' + data.autoPushInterval + 'min)' : 'OFF'}\n`;
        msg += `Config valid: ${data.configValid ? 'Yes' : 'No'}\n`;
        if (data.gitStatus) {
            const gs = data.gitStatus;
            msg += `Branch: ${gs.current}, Ahead: ${gs.ahead}, Behind: ${gs.behind}\n`;
            msg += `Changes pending: ${gs.hasChanges ? 'Yes' : 'No'}\n`;
        }
        if (data.syncLog?.length > 0) {
            msg += `\nLast: ${data.syncLog[0].message}`;
        }
        toastr.info(msg, 'GitHub Sync', { timeOut: 10000 });
    } catch (err) {
        toastr.error('Status check failed: ' + err.message, 'GitHub Sync');
    }
}

// ===================== Dialog =====================

function showConfirmDialog(title, message) {
    return new Promise((resolve) => {
        const id = 'sync-confirm-' + Date.now();
        const html = [
            '<div id="' + id + '" class="dialog-modal">',
            '<div class="dialog-content">',
            '<h4>' + escapeHtml(title) + '</h4>',
            '<p>' + escapeHtml(message) + '</p>',
            '<div class="dialog-buttons">',
            '<button class="btn btn-danger" data-action="confirm">Confirm</button>',
            '<button class="btn btn-secondary" data-action="cancel">Cancel</button>',
            '</div></div></div>'
        ].join('');
        $('body').append(html);
        $('#' + id).on('click', '[data-action]', function () {
            $('#' + id).remove();
            resolve($(this).data('action') === 'confirm');
        });
    });
}

// ===================== UI =====================

async function refreshAllUI() {
    try {
        const data = await apiCall('GET', '/status');
        // Status indicator
        const $s = $('#sync-status-indicator');
        if ($s.length) {
            if (data.syncInProgress) $s.text('Syncing...').css('color', '#f0ad4e');
            else if (!data.configValid) $s.text('Not configured').css('color', '#d9534f');
            else $s.text('Idle').css('color', '#5cb85c');
        }
        // Float button status
        const dot = $('#sync-float-status');
        if (dot.length) {
            const cls = !data.configValid ? 'noconfig' : data.syncInProgress ? 'syncing' : 'idle';
            dot.removeClass('idle syncing error noconfig').addClass(cls);
        }
        // Log
        const $log = $('#sync-log-container');
        if ($log.length && data.syncLog) {
            const icons = { success: '✅', error: '❌', warning: '⚠', info: 'ℹ' };
            const entries = data.syncLog.slice(0, 10).map(function (e) {
                const time = new Date(e.timestamp).toLocaleTimeString();
                const icon = icons[e.type] || '';
                return '<div class="sync-log-entry sync-log-' + e.type + '">' + icon + ' ' + time + ' - ' + escapeHtml(e.message) + '</div>';
            }).join('');
            $log.html(entries || '<div class="sync-log-entry">No sync history yet.</div>');
        }
    } catch (e) { /* ignore */ }
}

// ===================== Backup Management =====================

async function loadBackupList() {
    try {
        var data = await apiCall('GET', '/backups');
        var $list = $('#sync-backup-list');
        if (!data.backups || data.backups.length === 0) {
            $list.html('<div style="color:#777;font-size:12px;">No backups yet.</div>');
            return;
        }
        var html = data.backups.map(function (b) {
            var ts = b.id.replace(/T/g, ' ').substring(0,16);
            return '<div style="display:flex;align-items:center;gap:4px;padding:3px 0;border-bottom:1px solid #222;font-size:12px;">' +
                '<span style="flex:1;color:#ccc;">' + escapeHtml(ts) + ' (' + escapeHtml(b.sizeFormatted) + ')</span>' +
                '<button class="btn btn-sm sync-backup-restore" data-id="' + escapeHtml(b.id) + '" title="Restore">Restore</button>' +
                '<button class="btn btn-sm sync-backup-delete" data-id="' + escapeHtml(b.id) + '" title="Delete">Del</button>' +
                '</div>';
        }).join('');
        $list.html(html);
    } catch { /* ignore */ }
}

async function doBackups() {
    try {
        var data = await apiCall('GET', '/backups');
        if (!data.backups || data.backups.length === 0) {
            toastr.info('No backups found.', 'GitHub Sync');
            return;
        }
        var msg = 'Backups:\n' + data.backups.map(function (b, i) {
            return '[' + (i + 1) + '] ' + b.id.replace(/T/g, ' ').substring(0, 16) + ' - ' + b.sizeFormatted + ' (' + b.categories.join(', ') + ')';
        }).join('\n');
        toastr.info(msg, 'GitHub Sync', { timeOut: 15000 });
    } catch (err) { toastr.error('Failed: ' + err.message, 'GitHub Sync'); }
}

async function doRestore(index) {
    try {
        var data = await apiCall('GET', '/backups');
        if (!data.backups || data.backups.length === 0) {
            toastr.info('No backups found.', 'GitHub Sync');
            return;
        }
        var idx = (typeof index === 'number') ? index - 1 : 0;
        if (idx < 0 || idx >= data.backups.length) {
            toastr.error('Invalid backup index. Use /sync-backups to list.', 'GitHub Sync');
            return;
        }
        var backupId = data.backups[idx].id;
        var confirmed = await showConfirmDialog('Restore Backup?', 'Overwrite current data with backup from ' + backupId.replace(/T/g, ' ').substring(0, 16) + '?');
        if (!confirmed) return;
        toastr.info('Restoring backup...', 'GitHub Sync');
        var result = await apiCall('POST', '/backup/restore', { backupId: backupId });
        toastr.success('Restored: ' + result.restored.join(', '), 'GitHub Sync');
        refreshAllUI();
    } catch (err) { toastr.error('Restore failed: ' + err.message, 'GitHub Sync'); }
}

// ===================== Settings Panel =====================

function buildSettingsHtml() {
    // Simplified settings panel - all in one compact card
    return [
        '<div id="github-data-sync-settings" class="github-data-sync-panel">',

        // Repo Config
        '<div class="inline-drawer">',
        '<div class="inline-drawer-toggle inline-drawer-header"><b>Repository Configuration</b>',
        '<div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div></div>',
        '<div class="inline-drawer-content" style="padding:8px 12px;">',
        '<div class="form-group"><label>GitHub Repository <small>(username/repo-name)</small></label>',
        '<input type="text" id="sync-github-repo" class="text_pole" placeholder="username/my-sync-repo"></div>',
        '<div class="form-group"><label>Branch</label>',
        '<input type="text" id="sync-branch" class="text_pole" placeholder="main"></div>',
        '<div class="form-group"><label>Personal Access Token</label>',
        '<div class="sync-token-row">',
        '<input type="password" id="sync-github-token" class="text_pole" placeholder="ghp_...">',
        '<button id="sync-toggle-token" class="btn btn-sm" type="button"><span class="fa fa-eye"></span></button></div>',
        '<small>Requires <code>repo</code> scope.</small></div>',
        '<button id="sync-test-connection" class="btn btn-secondary" style="margin-top:6px;">Test Connection</button>',
        '<span id="sync-test-result"></span></div></div>',

        // Data Selection
        '<div class="inline-drawer">',
        '<div class="inline-drawer-toggle inline-drawer-header"><b>Data to Sync</b>',
        '<div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div></div>',
        '<div class="inline-drawer-content" style="padding:8px 12px;"><div class="sync-checkbox-grid">',
        '<label class="checkbox_label"><input type="checkbox" id="sync-data-characters">Characters</label>',
        '<label class="checkbox_label"><input type="checkbox" id="sync-data-chats">Chats</label>',
        '<label class="checkbox_label"><input type="checkbox" id="sync-data-worlds">Worlds</label>',
        '<label class="checkbox_label"><input type="checkbox" id="sync-data-groups">Groups</label>',
        '<label class="checkbox_label"><input type="checkbox" id="sync-data-settings">Settings</label>',
        '<label class="checkbox_label"><input type="checkbox" id="sync-data-presets">Presets</label>',
        '<label class="checkbox_label"><input type="checkbox" id="sync-data-personas">Personas</label>',
        '<label class="checkbox_label"><input type="checkbox" id="sync-data-backgrounds">Backgrounds</label>',
        '<label class="checkbox_label"><input type="checkbox" id="sync-data-themes">Themes</label>',
        '</div></div></div>',

        // Auto Push
        '<div class="inline-drawer">',
        '<div class="inline-drawer-toggle inline-drawer-header"><b>Auto-Push</b>',
        '<div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div></div>',
        '<div class="inline-drawer-content" style="padding:8px 12px;">',
        '<label class="checkbox_label"><input type="checkbox" id="sync-autopush-enabled">Enable automatic push</label>',
        '<div class="form-group"><label>Interval (minutes, min 5)</label>',
        '<input type="number" id="sync-autopush-interval" class="text_pole" min="5" value="30" step="5"></div>',
        '</div></div>',

        // Auto Backup
        '<div class="inline-drawer">',
        '<div class="inline-drawer-toggle inline-drawer-header"><b>Backup</b>',
        '<div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div></div>',
        '<div class="inline-drawer-content" style="padding:8px 12px;">',
        '<label class="checkbox_label"><input type="checkbox" id="sync-autobackup-enabled">Auto-backup before pull</label>',
        '<div class="form-group"><label>Max backups (1-50)</label>',
        '<input type="number" id="sync-autobackup-max" class="text_pole" min="1" max="50" value="5"></div>',
        '<button id="sync-backup-now" class="btn btn-secondary">Create Backup Now</button>',
        '<div id="sync-backup-list" style="margin-top:8px;max-height:150px;overflow-y:auto;"></div>',
        '</div></div>',

        // Controls & Log
        '<div class="inline-drawer">',
        '<div class="inline-drawer-toggle inline-drawer-header"><b>Controls & Status</b>',
        '<div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div></div>',
        '<div class="inline-drawer-content" style="padding:8px 12px;">',
        '<div class="sync-controls">',
        '<button id="sync-push-now" class="btn btn-primary">Push Now</button>',
        '<button id="sync-pull-now" class="btn btn-primary">Pull Now</button>',
        '<span class="sync-status-label">Status: <span id="sync-status-indicator">Checking...</span></span>',
        '</div>',
        '<h4 style="margin-top:12px;">Sync Log</h4>',
        '<div id="sync-log-container" class="sync-log"><div class="sync-log-entry">Loading...</div></div>',
        '</div></div>',

        '</div>', // end panel

        // Styles
        '<style>',
        '.github-data-sync-panel .inline-drawer{margin-bottom:4px;}',
        '.github-data-sync-panel .form-group{margin-bottom:8px;}',
        '.github-data-sync-panel .form-group label{display:block;margin-bottom:2px;font-size:13px;color:#aaa;}',
        '.github-data-sync-panel .form-group small{display:block;margin-top:2px;color:#777;}',
        '.sync-token-row{display:flex;gap:4px;align-items:center;}',
        '.sync-token-row input{flex:1;}',
        '.sync-checkbox-grid{display:grid;grid-template-columns:1fr 1fr 1fr;gap:4px 12px;}',
        '.sync-checkbox-grid .checkbox_label{display:flex!important;align-items:center;gap:4px;font-size:13px;margin:0;cursor:pointer;color:#ccc;}',
        '.checkbox_label input{margin:0;}',
        '.sync-controls{display:flex;gap:8px;align-items:center;margin:8px 0;}',
        '.sync-status-label{margin-left:12px;font-size:13px;color:#aaa;}',
        '.sync-log{background:#1a1a1a;border:1px solid #333;border-radius:4px;padding:8px;max-height:200px;overflow-y:auto;font-size:12px;font-family:monospace;}',
        '.sync-log-entry{padding:2px 0;border-bottom:1px solid #222;line-height:1.5;}',
        '.sync-log-entry:last-child{border-bottom:none;}',
        '.sync-log-error{color:#d9534f;} .sync-log-success{color:#5cb85c;}',
        '.sync-log-warning{color:#f0ad4e;} .sync-log-info{color:#aaa;}',
        '#sync-test-result{margin-left:8px;font-size:13px;}',
        // Float button
        '#sync-float-btn{position:fixed;bottom:80px;right:20px;width:48px;height:48px;background:#2a2a2a;border:2px solid #555;border-radius:50%;cursor:pointer;z-index:9999;display:flex;align-items:center;justify-content:center;transition:all 0.2s;box-shadow:0 2px 8px rgba(0,0,0,0.4);}',
        '#sync-float-btn:hover{border-color:#888;background:#333;}',
        '.sync-float-icon{color:#ccc;display:flex;align-items:center;justify-content:center;}',
        '#sync-float-status{position:absolute;bottom:2px;right:2px;width:12px;height:12px;border-radius:50%;border:2px solid #1a1a1a;}',
        '#sync-float-status.idle{background:#5cb85c;} #sync-float-status.syncing{background:#f0ad4e;animation:sync-pulse 0.8s infinite;}',
        '#sync-float-status.error{background:#d9534f;} #sync-float-status.noconfig{background:#777;}',
        '@keyframes sync-pulse{0%,100%{opacity:1}50%{opacity:0.3}}',
        '#sync-float-menu{position:fixed;bottom:136px;right:20px;background:#2a2a2a;border:1px solid #555;border-radius:8px;padding:4px 0;z-index:9998;display:none;min-width:150px;box-shadow:0 4px 12px rgba(0,0,0,0.5);}',
        '#sync-float-menu.show{display:block;}',
        '.sync-float-menu-item{padding:8px 16px;cursor:pointer;color:#ccc;font-size:13px;display:flex;align-items:center;gap:8px;transition:background 0.15s;}',
        '.sync-float-menu-item:hover{background:#3a3a3a;color:#fff;}',
        '.sync-float-menu-item span{font-size:16px;}',
        // Dialog
        '.dialog-modal{position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.6);display:flex;align-items:center;justify-content:center;z-index:99999;}',
        '.dialog-content{background:#2a2a2a;border:1px solid #555;border-radius:8px;padding:20px;max-width:400px;width:90%;}',
        '.dialog-content h4{margin:0 0 8px 0;color:#fff;}',
        '.dialog-content p{margin:0 0 16px 0;color:#ccc;}',
        '.dialog-buttons{display:flex;gap:8px;justify-content:flex-end;}',
        '</style>',
    ].join('');
}

function bindSettingsEvents() {
    const $panel = $('#github-data-sync-settings');
    if (!$panel.length) return;

    // Load config into form
    loadConfig().then(function (cfg) {
        $('#sync-github-repo').val(cfg.githubRepo || '');
        $('#sync-branch').val(cfg.branch || 'main');
        $('#sync-github-token').val(cfg.githubToken || '');
        var ds = cfg.dataSelection || {};
        $('#sync-data-characters').prop('checked', ds.characters !== false);
        $('#sync-data-chats').prop('checked', ds.chats !== false);
        $('#sync-data-worlds').prop('checked', ds.worlds !== false);
        $('#sync-data-groups').prop('checked', ds.groups !== false);
        $('#sync-data-settings').prop('checked', ds.settings !== false);
        $('#sync-data-presets').prop('checked', ds.presets !== false);
        $('#sync-data-personas').prop('checked', ds.personas !== false);
        $('#sync-data-backgrounds').prop('checked', ds.backgrounds === true);
        $('#sync-data-themes').prop('checked', ds.themes === true);
        var ap = cfg.autoPush || {};
        $('#sync-autopush-enabled').prop('checked', ap.enabled === true);
        $('#sync-autopush-interval').val(ap.intervalMinutes || 30);
        var ab = cfg.autoBackup || {};
        $('#sync-autobackup-enabled').prop('checked', ab.enabled !== false);
        $('#sync-autobackup-max').val(ab.maxBackups || 5);
        $('#sync-pull-confirmation').prop('checked', cfg.pullConfirmation !== false);
        refreshAllUI();
        loadBackupList();
    });

    // Debounced save
    var saveTimeout;
    function collectAndSave() {
        saveConfig({
            githubRepo: $('#sync-github-repo').val().trim(),
            branch: $('#sync-branch').val().trim() || 'main',
            githubToken: $('#sync-github-token').val().trim(),
            dataSelection: {
                characters: $('#sync-data-characters').is(':checked'),
                chats: $('#sync-data-chats').is(':checked'),
                worlds: $('#sync-data-worlds').is(':checked'),
                groups: $('#sync-data-groups').is(':checked'),
                settings: $('#sync-data-settings').is(':checked'),
                presets: $('#sync-data-presets').is(':checked'),
                personas: $('#sync-data-personas').is(':checked'),
                backgrounds: $('#sync-data-backgrounds').is(':checked'),
                themes: $('#sync-data-themes').is(':checked'),
            },
            autoPush: {
                enabled: $('#sync-autopush-enabled').is(':checked'),
                intervalMinutes: parseInt($('#sync-autopush-interval').val()) || 30,
            },
            autoBackup: {
                enabled: $('#sync-autobackup-enabled').is(':checked'),
                maxBackups: parseInt($('#sync-autobackup-max').val()) || 5,
            },
            pullConfirmation: $('#sync-pull-confirmation').is(':checked'),
        });
    }
    $panel.on('change input', 'input', function () {
        clearTimeout(saveTimeout);
        saveTimeout = setTimeout(collectAndSave, 500);
    });

    // Toggle token
    $('#sync-toggle-token').on('click', function () {
        var $t = $('#sync-github-token');
        var show = $t.attr('type') === 'password';
        $t.attr('type', show ? 'text' : 'password');
        $('#sync-toggle-token .fa').toggleClass('fa-eye fa-eye-slash');
    });

    // Test connection
    $('#sync-test-connection').on('click', async function () {
        await saveConfig({
            githubRepo: $('#sync-github-repo').val().trim(),
            branch: $('#sync-branch').val().trim() || 'main',
            githubToken: $('#sync-github-token').val().trim(),
        });
        var $r = $('#sync-test-result');
        $r.text('Testing...').css('color', '#f0ad4e');
        try {
            var data = await apiCall('GET', '/validate');
            if (data.valid) {
                $r.text(data.message || 'Connection OK').css('color', '#5cb85c');
            } else {
                $r.text('Failed: ' + (data.errors || ['Unknown']).join(', ')).css('color', '#d9534f');
            }
        } catch (err) {
            $r.text('Error: ' + err.message).css('color', '#d9534f');
        }
    });

    // Manual buttons
    $('#sync-push-now').on('click', doPush);
    $('#sync-pull-now').on('click', doPull);

    // Backup
    $('#sync-backup-now').on('click', async function () {
        try {
            toastr.info('Creating backup...', 'GitHub Sync');
            var data = await apiCall('POST', '/backup/create');
            if (data.message) { toastr.info(data.message, 'GitHub Sync'); }
            else { toastr.success('Backup created: ' + (data.sizeFormatted || ''), 'GitHub Sync'); }
            loadBackupList();
        } catch (err) { toastr.error('Backup failed: ' + err.message, 'GitHub Sync'); }
    });
    $('#sync-backup-list').on('click', '.sync-backup-restore', async function () {
        var id = $(this).data('id');
        var confirmed = await showConfirmDialog('Restore Backup?', 'This will overwrite current data with the backup from ' + id.replace(/T/g, ' ').substring(0, 16) + '. Continue?');
        if (!confirmed) return;
        try {
            toastr.info('Restoring backup...', 'GitHub Sync');
            var data = await apiCall('POST', '/backup/restore', { backupId: id });
            toastr.success('Restored: ' + data.restored.join(', '), 'GitHub Sync');
            refreshAllUI();
        } catch (err) { toastr.error('Restore failed: ' + err.message, 'GitHub Sync'); }
    });
    $('#sync-backup-list').on('click', '.sync-backup-delete', async function () {
        var id = $(this).data('id');
        try {
            await apiCall('DELETE', '/backup/' + encodeURIComponent(id));
            toastr.info('Backup deleted.', 'GitHub Sync');
            loadBackupList();
        } catch (err) { toastr.error('Delete failed: ' + err.message, 'GitHub Sync'); }
    });

    // Auto refresh
    setInterval(refreshAllUI, 30000);
}

function createFloatButton() {
    if ($('#sync-float-btn').length) return;
    var html = [
        '<div id="sync-float-btn" title="GitHub Data Sync">',
        '<div class="sync-float-icon">',
        '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">',
        '<circle cx="12" cy="12" r="10"/>',
        '<polyline points="12 6 12 18"/>',
        '<polyline points="8 10 12 6 16 10"/>',
        '</svg></div>',
        '<div id="sync-float-status"></div>',
        '<div id="sync-float-menu">',
        '<div class="sync-float-menu-item" data-action="push"><span>&#128228;</span> Push Now</div>',
        '<div class="sync-float-menu-item" data-action="pull"><span>&#128229;</span> Pull Now</div>',
        '<div class="sync-float-menu-item" data-action="status"><span>&#8505;</span> Status</div>',
        '</div></div>'
    ].join('');
    $('body').append(html);

    $('#sync-float-btn').on('click', function (e) {
        e.stopPropagation();
        $('#sync-float-menu').toggleClass('show');
    });
    $('#sync-float-menu').on('click', '[data-action]', function (e) {
        e.stopPropagation();
        $('#sync-float-menu').removeClass('show');
        var action = $(this).data('action');
        if (action === 'push') doPush();
        else if (action === 'pull') doPull();
        else if (action === 'status') doStatus();
    });
    $(document).on('click', function () {
        $('#sync-float-menu').removeClass('show');
    });

    refreshAllUI();
}

// ===================== MAIN INIT (DOM ready) =====================

$(function () {
    try {
        // Register slash commands using the proper API
        SlashCommandParser.addCommandObject(SlashCommand.fromProps({
            name: 'sync-push',
            callback: doPush,
            helpString: 'Push SillyTavern data to the configured GitHub repository.',
        }));
        SlashCommandParser.addCommandObject(SlashCommand.fromProps({
            name: 'sync-pull',
            callback: doPull,
            helpString: 'Pull the latest data from the configured GitHub repository and restore it locally.',
        }));
        SlashCommandParser.addCommandObject(SlashCommand.fromProps({
            name: 'sync-status',
            callback: doStatus,
            helpString: 'Display current GitHub sync configuration and recent operations.',
        }));
        SlashCommandParser.addCommandObject(SlashCommand.fromProps({
            name: 'sync-backups',
            callback: doBackups,
            helpString: 'List all local backups created before pull operations.',
        }));
        SlashCommandParser.addCommandObject(SlashCommand.fromProps({
            name: 'sync-restore',
            callback: doRestore,
            helpString: 'Restore data from a backup. Usage: /sync-restore <number> (use /sync-backups to list).',
            unnamedArgument: { name: 'N', type: 'integer', isRequired: true },
        }));

        // Add settings panel
        var $target = $('#extensions_settings');
        if (!$target.length) $target = $('#extensions_settings_container');
        if (!$target.length) $target = $('body');
        $target.append(buildSettingsHtml());
        bindSettingsEvents();

        // Create floating button
        createFloatButton();

        console.log('[GitHub-Data-Sync] Initialized. Slash commands: /sync-push /sync-pull /sync-status');
    } catch (err) {
        console.error('[GitHub-Data-Sync] Init failed:', err);
    }
});