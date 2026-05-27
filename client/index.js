// GitHub Data Sync - Frontend Extension for SillyTavern
// Place this file in: public/scripts/extensions/third-party/github-data-sync.js

import { registerSlashCommand } from '../../slash-commands.js';
import { extension_settings, saveSettingsDebounced } from '../../extensions.js';

const PLUGIN_NAME = 'github-data-sync';
const API_BASE = '/api/plugins/github-data-sync';

// ===================== API helpers =====================

async function apiCall(method, endpoint, body) {
    const opts = { method, headers: { 'Content-Type': 'application/json' } };
    if (body) opts.body = JSON.stringify(body);
    const resp = await fetch(`${API_BASE}${endpoint}`, opts);
    const data = await resp.json();
    if (!data.success) {
        throw new Error(data.error || data.errors?.join(', ') || 'Unknown error');
    }
    return data;
}

// ===================== Sync operations =====================

async function doPush() {
    try {
        toastr.info('Pushing data to GitHub...', 'GitHub Sync');
        updateFloatStatus('syncing');
        const result = await apiCall('POST', '/push');
        if (result.skipped) {
            toastr.warning('No changes to push.', 'GitHub Sync');
        } else {
            const files = result.filesChanged?.join(', ') || '';
            toastr.success(`Push successful: ${files}`, 'GitHub Sync');
        }
        updateFloatStatus('idle');
        refreshAllUI();
    } catch (err) {
        toastr.error(`Push failed: ${err.message}`, 'GitHub Sync');
        updateFloatStatus('error');
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
        updateFloatStatus('syncing');
        const result = await apiCall('POST', '/pull');
        if (result.conflicts?.length > 0) {
            toastr.warning(`Pull completed with conflicts in: ${result.conflicts.join(', ')}`, 'GitHub Sync');
        } else {
            const files = result.filesRestored?.join(', ') || '';
            toastr.success(`Pull successful: ${files}`, 'GitHub Sync');
        }
        updateFloatStatus('idle');
        refreshAllUI();
    } catch (err) {
        toastr.error(`Pull failed: ${err.message}`, 'GitHub Sync');
        updateFloatStatus('error');
    }
}

async function doStatus() {
    try {
        const data = await apiCall('GET', '/status');
        let msg = `Auto-push: ${data.autoPushEnabled ? `ON (every ${data.autoPushInterval}min)` : 'OFF'}\n`;
        msg += `Config valid: ${data.configValid ? 'Yes' : 'No'}\n`;
        msg += `Sync in progress: ${data.syncInProgress ? 'Yes' : 'No'}\n`;
        if (data.gitStatus) {
            msg += `Branch: ${data.gitStatus.current}\n`;
            msg += `Ahead: ${data.gitStatus.ahead}, Behind: ${data.gitStatus.behind}\n`;
            msg += `Changes pending: ${data.gitStatus.hasChanges ? 'Yes' : 'No'}`;
        }
        if (data.syncLog?.length > 0) {
            msg += `\n\nLast sync: ${data.syncLog[0].message}`;
        }
        toastr.info(msg, 'GitHub Sync Status', { timeOut: 10000 });
    } catch (err) {
        toastr.error(`Status check failed: ${err.message}`, 'GitHub Sync');
    }
}

// ===================== Dialog =====================

function showConfirmDialog(title, message) {
    return new Promise((resolve) => {
        const id = `sync-confirm-${Date.now()}`;
        const html = `
        <div id="${id}" class="dialog-modal">
            <div class="dialog-content">
                <h4>${escapeHtml(title)}</h4>
                <p>${escapeHtml(message)}</p>
                <div class="dialog-buttons">
                    <button class="btn btn-danger" data-action="confirm">Confirm</button>
                    <button class="btn btn-secondary" data-action="cancel">Cancel</button>
                </div>
            </div>
        </div>`;
        $('body').append(html);
        $(`#${id}`).on('click', '[data-action]', function () {
            $(`#${id}`).remove();
            resolve($(this).data('action') === 'confirm');
        });
    });
}

function escapeHtml(str) {
    return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ===================== Config =====================

async function loadConfig() {
    try { const data = await apiCall('GET', '/config'); return data.config || {}; }
    catch { return {}; }
}

async function saveConfig(partial) {
    try { const data = await apiCall('PUT', '/config', partial); return data.config || {}; }
    catch (err) { toastr.error(`Save failed: ${err.message}`, 'GitHub Sync'); return null; }
}

// ===================== UI refresh =====================

async function refreshAllUI() {
    await Promise.all([refreshStatusIndicator(), refreshLogDisplay(), refreshFloatButton()]);
}

async function refreshStatusIndicator() {
    try {
        const data = await apiCall('GET', '/status');
        const $s = $('#sync-status-indicator');
        if (!$s.length) return;
        if (data.syncInProgress) {
            $s.text('Syncing...').css('color', '#f0ad4e');
        } else if (!data.configValid) {
            $s.text('Not configured').css('color', '#d9534f');
        } else {
            $s.text('Idle').css('color', '#5cb85c');
        }
    } catch { /* ignore */ }
}

async function refreshLogDisplay() {
    try {
        const data = await apiCall('GET', '/status');
        const $log = $('#sync-log-container');
        if (!$log.length || !data.syncLog) return;
        const entries = data.syncLog.slice(0, 10).map(e => {
            const time = new Date(e.timestamp).toLocaleTimeString();
            const icon = { success: '&#9989;', error: '&#10060;', warning: '&#9888;', info: '&#8505;' }[e.type] || '';
            return `<div class="sync-log-entry sync-log-${e.type}">${icon} ${time} - ${escapeHtml(e.message)}</div>`;
        }).join('');
        $log.html(entries || '<div class="sync-log-entry">No sync history yet.</div>');
    } catch { /* ignore */ }
}

async function refreshFloatButton() {
    try {
        const data = await apiCall('GET', '/status');
        if (!data.configValid) {
            updateFloatStatus('noconfig');
        } else if (data.syncInProgress) {
            updateFloatStatus('syncing');
        } else {
            updateFloatStatus('idle');
        }
    } catch { updateFloatStatus('error'); }
}

// ===================== Floating Action Button =====================

function createFloatButton() {
    if ($('#sync-float-btn').length) return;

    const html = `
    <div id="sync-float-btn" class="sync-float-btn" title="GitHub Data Sync">
        <div class="sync-float-icon">
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <circle cx="12" cy="12" r="10"/>
                <polyline points="12 6 12 18"/>
                <polyline points="8 10 12 6 16 10"/>
            </svg>
        </div>
        <div class="sync-float-status" id="sync-float-status"></div>
        <div class="sync-float-menu" id="sync-float-menu">
            <div class="sync-float-menu-item" data-action="push">
                <span>&#128228;</span> Push Now
            </div>
            <div class="sync-float-menu-item" data-action="pull">
                <span>&#128229;</span> Pull Now
            </div>
            <div class="sync-float-menu-item" data-action="status">
                <span>&#8505;</span> Status
            </div>
        </div>
    </div>`;

    $('body').append(html);

    // Toggle menu on click
    $('#sync-float-btn').on('click', function (e) {
        e.stopPropagation();
        $('#sync-float-menu').toggleClass('show');
    });

    // Menu item clicks
    $('#sync-float-menu').on('click', '[data-action]', function (e) {
        e.stopPropagation();
        $('#sync-float-menu').removeClass('show');
        const action = $(this).data('action');
        if (action === 'push') doPush();
        else if (action === 'pull') doPull();
        else if (action === 'status') doStatus();
    });

    // Close menu when clicking elsewhere
    $(document).on('click', function () {
        $('#sync-float-menu').removeClass('show');
    });

    // Load initial state
    refreshFloatButton();
}

function updateFloatStatus(state) {
    const $dot = $('#sync-float-status');
    if (!$dot.length) return;
    $dot.removeClass('idle syncing error noconfig');
    $dot.addClass(state);
    const titles = { idle: 'Ready', syncing: 'Syncing...', error: 'Error', noconfig: 'Not configured' };
    $dot.attr('title', titles[state] || '');
}

// ===================== Settings Panel =====================

function buildSettingsHtml() {
    return `
    <div id="github-data-sync-settings" class="github-data-sync-panel">

        <!-- Repository Configuration -->
        <div class="inline-drawer">
            <div class="inline-drawer-toggle inline-drawer-header">
                <b>Repository Configuration</b>
                <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
            </div>
            <div class="inline-drawer-content" style="padding: 8px 12px;">
                <div class="form-group">
                    <label>GitHub Repository <small>(username/repo-name)</small></label>
                    <input type="text" id="sync-github-repo" class="text_pole" placeholder="username/my-sync-repo" />
                </div>
                <div class="form-group">
                    <label>Branch</label>
                    <input type="text" id="sync-branch" class="text_pole" placeholder="main" />
                </div>
                <div class="form-group">
                    <label>Personal Access Token</label>
                    <div class="sync-token-row">
                        <input type="password" id="sync-github-token" class="text_pole" placeholder="ghp_..." />
                        <button id="sync-toggle-token" class="btn btn-sm" type="button" title="Show/hide token">
                            <span class="fa fa-eye"></span>
                        </button>
                    </div>
                    <small>Requires <code>repo</code> scope. <a href="https://github.com/settings/tokens" target="_blank">Create token</a></small>
                </div>
                <div class="form-group" style="margin-top:8px;">
                    <button id="sync-test-connection" class="btn btn-secondary">Test Connection</button>
                    <span id="sync-test-result"></span>
                </div>
            </div>
        </div>

        <!-- Data Selection -->
        <div class="inline-drawer">
            <div class="inline-drawer-toggle inline-drawer-header">
                <b>Data to Sync</b>
                <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
            </div>
            <div class="inline-drawer-content" style="padding: 8px 12px;">
                <div class="sync-checkbox-grid">
                    <label class="checkbox_label"><input type="checkbox" id="sync-data-characters" /> Characters</label>
                    <label class="checkbox_label"><input type="checkbox" id="sync-data-chats" /> Chats</label>
                    <label class="checkbox_label"><input type="checkbox" id="sync-data-worlds" /> Worlds</label>
                    <label class="checkbox_label"><input type="checkbox" id="sync-data-groups" /> Groups</label>
                    <label class="checkbox_label"><input type="checkbox" id="sync-data-settings" /> Settings</label>
                    <label class="checkbox_label"><input type="checkbox" id="sync-data-presets" /> Presets</label>
                    <label class="checkbox_label"><input type="checkbox" id="sync-data-personas" /> Personas</label>
                    <label class="checkbox_label"><input type="checkbox" id="sync-data-backgrounds" /> Backgrounds</label>
                    <label class="checkbox_label"><input type="checkbox" id="sync-data-themes" /> Themes</label>
                </div>
            </div>
        </div>

        <!-- Auto Push -->
        <div class="inline-drawer">
            <div class="inline-drawer-toggle inline-drawer-header">
                <b>Auto-Push Settings</b>
                <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
            </div>
            <div class="inline-drawer-content" style="padding: 8px 12px;">
                <div class="form-group">
                    <label class="checkbox_label">
                        <input type="checkbox" id="sync-autopush-enabled" /> Enable automatic push
                    </label>
                </div>
                <div class="form-group">
                    <label>Interval (minutes, minimum 5)</label>
                    <input type="number" id="sync-autopush-interval" class="text_pole" min="5" value="30" step="5" />
                </div>
            </div>
        </div>

        <!-- Pull Settings -->
        <div class="inline-drawer">
            <div class="inline-drawer-toggle inline-drawer-header">
                <b>Pull Settings</b>
                <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
            </div>
            <div class="inline-drawer-content" style="padding: 8px 12px;">
                <div class="form-group">
                    <label class="checkbox_label">
                        <input type="checkbox" id="sync-pull-confirmation" /> Require confirmation before pulling
                    </label>
                </div>
            </div>
        </div>

        <!-- Manual Controls & Status -->
        <div class="inline-drawer">
            <div class="inline-drawer-toggle inline-drawer-header">
                <b>Manual Controls & Status</b>
                <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
            </div>
            <div class="inline-drawer-content" style="padding: 8px 12px;">
                <div class="sync-controls">
                    <button id="sync-push-now" class="btn btn-primary">Push Now</button>
                    <button id="sync-pull-now" class="btn btn-primary">Pull Now</button>
                    <span class="sync-status-label">Status: <span id="sync-status-indicator">Checking...</span></span>
                </div>
                <h4 style="margin-top:12px;">Sync Log</h4>
                <div id="sync-log-container" class="sync-log">
                    <div class="sync-log-entry">Loading...</div>
                </div>
            </div>
        </div>

    </div>

    <style>
        /* ---- Floating Button ---- */
        .sync-float-btn {
            position: fixed;
            bottom: 80px;
            right: 20px;
            width: 48px;
            height: 48px;
            background: #2a2a2a;
            border: 2px solid #555;
            border-radius: 50%;
            cursor: pointer;
            z-index: 9999;
            display: flex;
            align-items: center;
            justify-content: center;
            transition: all 0.2s;
            box-shadow: 0 2px 8px rgba(0,0,0,0.4);
        }
        .sync-float-btn:hover {
            border-color: #888;
            background: #333;
        }
        .sync-float-icon {
            color: #ccc;
            display: flex;
            align-items: center;
            justify-content: center;
        }
        .sync-float-status {
            position: absolute;
            bottom: 2px;
            right: 2px;
            width: 12px;
            height: 12px;
            border-radius: 50%;
            border: 2px solid #1a1a1a;
        }
        .sync-float-status.idle { background: #5cb85c; }
        .sync-float-status.syncing { background: #f0ad4e; animation: sync-pulse 0.8s infinite; }
        .sync-float-status.error { background: #d9534f; }
        .sync-float-status.noconfig { background: #777; }
        @keyframes sync-pulse {
            0%, 100% { opacity: 1; }
            50% { opacity: 0.3; }
        }

        /* ---- Float Menu ---- */
        .sync-float-menu {
            position: fixed;
            bottom: 136px;
            right: 20px;
            background: #2a2a2a;
            border: 1px solid #555;
            border-radius: 8px;
            padding: 4px 0;
            z-index: 9998;
            display: none;
            min-width: 150px;
            box-shadow: 0 4px 12px rgba(0,0,0,0.5);
        }
        .sync-float-menu.show { display: block; }
        .sync-float-menu-item {
            padding: 8px 16px;
            cursor: pointer;
            color: #ccc;
            font-size: 13px;
            display: flex;
            align-items: center;
            gap: 8px;
            transition: background 0.15s;
        }
        .sync-float-menu-item:hover {
            background: #3a3a3a;
            color: #fff;
        }
        .sync-float-menu-item span {
            font-size: 16px;
        }

        /* ---- Settings Panel ---- */
        .github-data-sync-panel .inline-drawer {
            margin-bottom: 4px;
        }
        .github-data-sync-panel .form-group {
            margin-bottom: 8px;
        }
        .github-data-sync-panel .form-group label {
            display: block;
            margin-bottom: 2px;
            font-size: 13px;
            color: #aaa;
        }
        .github-data-sync-panel .form-group small {
            display: block;
            margin-top: 2px;
            color: #777;
        }
        .sync-token-row {
            display: flex;
            gap: 4px;
            align-items: center;
        }
        .sync-token-row input { flex: 1; }
        .sync-checkbox-grid {
            display: grid;
            grid-template-columns: 1fr 1fr 1fr;
            gap: 4px 12px;
        }
        .sync-checkbox-grid .checkbox_label {
            display: flex !important;
            align-items: center;
            gap: 4px;
            font-size: 13px;
            margin: 0;
            cursor: pointer;
            color: #ccc;
        }
        .checkbox_label input { margin: 0; }
        .sync-controls {
            display: flex;
            gap: 8px;
            align-items: center;
            margin: 8px 0;
        }
        .sync-status-label {
            margin-left: 12px;
            font-size: 13px;
            color: #aaa;
        }
        .sync-log {
            background: #1a1a1a;
            border: 1px solid #333;
            border-radius: 4px;
            padding: 8px;
            max-height: 200px;
            overflow-y: auto;
            font-size: 12px;
            font-family: monospace;
        }
        .sync-log-entry {
            padding: 2px 0;
            border-bottom: 1px solid #222;
            line-height: 1.5;
        }
        .sync-log-entry:last-child { border-bottom: none; }
        .sync-log-error { color: #d9534f; }
        .sync-log-success { color: #5cb85c; }
        .sync-log-warning { color: #f0ad4e; }
        .sync-log-info { color: #aaa; }
        #sync-test-result {
            margin-left: 8px;
            font-size: 13px;
        }

        /* ---- Confirm Dialog ---- */
        .dialog-modal {
            position: fixed;
            top: 0; left: 0; right: 0; bottom: 0;
            background: rgba(0,0,0,0.6);
            display: flex;
            align-items: center;
            justify-content: center;
            z-index: 99999;
        }
        .dialog-content {
            background: #2a2a2a;
            border: 1px solid #555;
            border-radius: 8px;
            padding: 20px;
            max-width: 400px;
            width: 90%;
        }
        .dialog-content h4 { margin: 0 0 8px 0; color: #fff; }
        .dialog-content p { margin: 0 0 16px 0; color: #ccc; }
        .dialog-buttons {
            display: flex;
            gap: 8px;
            justify-content: flex-end;
        }
    </style>`;
}

// ===================== Event binding =====================

function bindSettingsEvents() {
    const $panel = $('#github-data-sync-settings');
    if (!$panel.length) return;

    // Load config into form
    loadConfig().then(cfg => {
        $('#sync-github-repo').val(cfg.githubRepo || '');
        $('#sync-branch').val(cfg.branch || 'main');
        $('#sync-github-token').val(cfg.githubToken || '');
        const ds = cfg.dataSelection || {};
        $('#sync-data-characters').prop('checked', ds.characters !== false);
        $('#sync-data-chats').prop('checked', ds.chats !== false);
        $('#sync-data-worlds').prop('checked', ds.worlds !== false);
        $('#sync-data-groups').prop('checked', ds.groups !== false);
        $('#sync-data-settings').prop('checked', ds.settings !== false);
        $('#sync-data-presets').prop('checked', ds.presets !== false);
        $('#sync-data-personas').prop('checked', ds.personas !== false);
        $('#sync-data-backgrounds').prop('checked', ds.backgrounds === true);
        $('#sync-data-themes').prop('checked', ds.themes === true);
        const ap = cfg.autoPush || {};
        $('#sync-autopush-enabled').prop('checked', ap.enabled === true);
        $('#sync-autopush-interval').val(ap.intervalMinutes || 30);
        $('#sync-pull-confirmation').prop('checked', cfg.pullConfirmation !== false);
        refreshAllUI();
    });

    // Debounced save on any input change
    function collectAndSave() {
        const partial = {
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
            pullConfirmation: $('#sync-pull-confirmation').is(':checked'),
        };
        saveConfig(partial);
    }

    let saveTimeout;
    $panel.on('change input', 'input', () => {
        clearTimeout(saveTimeout);
        saveTimeout = setTimeout(collectAndSave, 500);
    });

    // Toggle token visibility
    $('#sync-toggle-token').on('click', () => {
        const $t = $('#sync-github-token');
        const show = $t.attr('type') === 'password';
        $t.attr('type', show ? 'text' : 'password');
        $('#sync-toggle-token .fa').toggleClass('fa-eye fa-eye-slash');
    });

    // Test connection
    $('#sync-test-connection').on('click', async () => {
        const partial = {
            githubRepo: $('#sync-github-repo').val().trim(),
            branch: $('#sync-branch').val().trim() || 'main',
            githubToken: $('#sync-github-token').val().trim(),
        };
        await saveConfig(partial);
        const $r = $('#sync-test-result');
        $r.text('Testing...').css('color', '#f0ad4e');
        try {
            const data = await apiCall('GET', '/validate');
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

    // Auto refresh
    setInterval(refreshAllUI, 30000);
}

// ===================== Init =====================

(async function init() {
    try {
        // Register slash commands
        registerSlashCommand('sync-push', doPush, {
            description: 'Push SillyTavern data to GitHub',
            helpText: 'Push selected SillyTavern data categories to the configured GitHub repository.',
        });
        registerSlashCommand('sync-pull', doPull, {
            description: 'Pull SillyTavern data from GitHub',
            helpText: 'Pull the latest data from the configured GitHub repository and restore it locally.',
        });
        registerSlashCommand('sync-status', doStatus, {
            description: 'Check GitHub sync status',
            helpText: 'Display current sync configuration status and recent operation log.',
        });

        // Add settings panel to Extensions area
        const $target = $('#extensions_settings').length
            ? $('#extensions_settings')
            : $('#extensions_settings_container').length
                ? $('#extensions_settings_container')
                : $('body');
        $target.append(buildSettingsHtml());
        bindSettingsEvents();

        // Create floating action button
        createFloatButton();

        console.log('[GitHub-Data-Sync] Frontend extension initialized. Settings panel + floating button ready.');
    } catch (err) {
        console.error('[GitHub-Data-Sync] Init failed:', err);
    }
})();