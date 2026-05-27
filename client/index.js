// GitHub Data Sync - Frontend Extension for SillyTavern
// Place this file in: public/scripts/extensions/third-party/github-data-sync.js
// Or load via the server plugin route.

import { registerSlashCommand } from '../../../slash-commands.js';
import { extension_settings, saveSettingsDebounced } from '../../../extensions.js';

const PLUGIN_NAME = 'github-data-sync';
const API_BASE = '/api/plugins/github-data-sync';

// ---------- API helpers ----------

async function apiCall(method, endpoint, body) {
    const opts = {
        method,
        headers: { 'Content-Type': 'application/json' },
    };
    if (body) opts.body = JSON.stringify(body);

    const resp = await fetch(`${API_BASE}${endpoint}`, opts);
    const data = await resp.json();

    if (!data.success) {
        throw new Error(data.error || data.errors?.join(', ') || 'Unknown error');
    }
    return data;
}

// ---------- Slash command callbacks ----------

async function cmdPush() {
    try {
        toastr.info('Pushing data to GitHub...', 'GitHub Sync');
        const result = await apiCall('POST', '/push');
        if (result.skipped) {
            toastr.warning('No changes to push.', 'GitHub Sync');
        } else {
            const files = result.filesChanged?.join(', ') || '';
            toastr.success(`Push successful: ${files}`, 'GitHub Sync');
        }
        refreshStatus();
    } catch (err) {
        toastr.error(`Push failed: ${err.message}`, 'GitHub Sync');
    }
}

async function cmdPull() {
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
            toastr.warning(`Pull completed with conflicts in: ${result.conflicts.join(', ')}`, 'GitHub Sync');
        } else {
            const files = result.filesRestored?.join(', ') || '';
            toastr.success(`Pull successful: ${files}`, 'GitHub Sync');
        }
        refreshStatus();
    } catch (err) {
        toastr.error(`Pull failed: ${err.message}`, 'GitHub Sync');
    }
}

async function cmdStatus() {
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
            msg += `\n\nLast sync: ${data.syncLog[0].message} (${new Date(data.syncLog[0].timestamp).toLocaleString()})`;
        }
        toastr.info(msg, 'GitHub Sync Status', { timeOut: 10000 });
    } catch (err) {
        toastr.error(`Status check failed: ${err.message}`, 'GitHub Sync');
    }
}

// ---------- Confirmation dialog ----------

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
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

// ---------- Config ----------

async function loadConfig() {
    try {
        const data = await apiCall('GET', '/config');
        return data.config || {};
    } catch {
        return {};
    }
}

async function saveConfig(partial) {
    try {
        const data = await apiCall('PUT', '/config', partial);
        return data.config || {};
    } catch (err) {
        toastr.error(`Config save failed: ${err.message}`, 'GitHub Sync');
        return null;
    }
}

// ---------- Status refresh ----------

async function refreshStatus() {
    try {
        const data = await apiCall('GET', '/status');
        const $status = $('#sync-status-indicator');
        if ($status.length) {
            if (data.syncInProgress) {
                $status.text('Syncing...').css('color', '#f0ad4e');
            } else if (!data.configValid) {
                $status.text('Not configured').css('color', '#d9534f');
            } else {
                $status.text('Idle').css('color', '#5cb85c');
            }
        }

        // Update sync log display
        const $log = $('#sync-log-container');
        if ($log.length && data.syncLog) {
            const entries = data.syncLog.slice(0, 10).map(e => {
                const time = new Date(e.timestamp).toLocaleTimeString();
                const icon = e.type === 'success' ? '&#9989;' : e.type === 'error' ? '&#10060;' : e.type === 'warning' ? '&#9888;' : '&#8505;';
                return `<div class="sync-log-entry sync-log-${e.type}">${icon} ${time} - ${escapeHtml(e.message)}</div>`;
            }).join('');
            $log.html(entries || '<div class="sync-log-entry">No sync history yet.</div>');
        }
    } catch {
        // Silently ignore status refresh errors
    }
}

// ---------- Settings HTML ----------

function buildSettingsHtml() {
    return `
    <div id="github-data-sync-settings" class="github-data-sync-panel">
        <h4>Repository Configuration</h4>
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
        <div class="form-group">
            <button id="sync-test-connection" class="btn btn-secondary">Test Connection</button>
            <span id="sync-test-result"></span>
        </div>

        <h4>Data to Sync</h4>
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

        <h4>Auto-Push</h4>
        <div class="form-group">
            <label class="checkbox_label">
                <input type="checkbox" id="sync-autopush-enabled" /> Enable automatic push
            </label>
        </div>
        <div class="form-group">
            <label>Interval (minutes, minimum 5)</label>
            <input type="number" id="sync-autopush-interval" class="text_pole" min="5" value="30" step="5" />
        </div>

        <h4>Pull Settings</h4>
        <div class="form-group">
            <label class="checkbox_label">
                <input type="checkbox" id="sync-pull-confirmation" /> Require confirmation before pulling
            </label>
        </div>

        <h4>Manual Controls</h4>
        <div class="sync-controls">
            <button id="sync-push-now" class="btn btn-primary">Push Now</button>
            <button id="sync-pull-now" class="btn btn-primary">Pull Now</button>
            <span class="sync-status-label">Status: <span id="sync-status-indicator">Checking...</span></span>
        </div>

        <h4>Sync Log</h4>
        <div id="sync-log-container" class="sync-log">
            <div class="sync-log-entry">Loading...</div>
        </div>
    </div>

    <style>
        .github-data-sync-panel h4 {
            margin-top: 16px;
            margin-bottom: 8px;
            border-bottom: 1px solid #444;
            padding-bottom: 4px;
            color: #ccc;
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
        .sync-token-row input {
            flex: 1;
        }
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
        }
        .checkbox_label input {
            margin: 0;
        }
        .sync-controls {
            display: flex;
            gap: 8px;
            align-items: center;
            margin: 12px 0;
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
        .sync-log-entry:last-child {
            border-bottom: none;
        }
        .sync-log-error { color: #d9534f; }
        .sync-log-success { color: #5cb85c; }
        .sync-log-warning { color: #f0ad4e; }
        .sync-log-info { color: #aaa; }
        #sync-test-result {
            margin-left: 8px;
            font-size: 13px;
        }
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
        .dialog-content h4 {
            margin: 0 0 8px 0;
            color: #fff;
        }
        .dialog-content p {
            margin: 0 0 16px 0;
            color: #ccc;
        }
        .dialog-buttons {
            display: flex;
            gap: 8px;
            justify-content: flex-end;
        }
    </style>`;
}

// ---------- Event binding ----------

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

        refreshStatus();
    });

    // Save on change (debounced by collecting and saving)
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

    // Debounced save on input change
    let saveTimeout;
    $panel.on('change input', 'input', () => {
        clearTimeout(saveTimeout);
        saveTimeout = setTimeout(collectAndSave, 500);
    });

    // Toggle token visibility
    $('#sync-toggle-token').on('click', () => {
        const $input = $('#sync-github-token');
        const isPassword = $input.attr('type') === 'password';
        $input.attr('type', isPassword ? 'text' : 'password');
        $('#sync-toggle-token .fa').toggleClass('fa-eye fa-eye-slash');
    });

    // Test connection
    $('#sync-test-connection').on('click', async () => {
        // Save current config first
        const partial = {
            githubRepo: $('#sync-github-repo').val().trim(),
            branch: $('#sync-branch').val().trim() || 'main',
            githubToken: $('#sync-github-token').val().trim(),
        };
        await saveConfig(partial);

        const $result = $('#sync-test-result');
        $result.text('Testing...').css('color', '#f0ad4e');
        try {
            const data = await apiCall('GET', '/validate');
            if (data.valid) {
                $result.text(data.message || 'Connection OK').css('color', '#5cb85c');
            } else {
                $result.text('Failed: ' + (data.errors || ['Unknown']).join(', ')).css('color', '#d9534f');
            }
        } catch (err) {
            $result.text('Error: ' + err.message).css('color', '#d9534f');
        }
    });

    // Manual push/pull buttons
    $('#sync-push-now').on('click', cmdPush);
    $('#sync-pull-now').on('click', cmdPull);

    // Periodic status refresh
    setInterval(refreshStatus, 30000);
}

// ---------- Init ----------

(async function init() {
    // Register slash commands
    registerSlashCommand('sync-push', cmdPush, {
        description: 'Push SillyTavern data to GitHub',
        helpText: 'Push selected SillyTavern data categories to the configured private GitHub repository.',
    });

    registerSlashCommand('sync-pull', cmdPull, {
        description: 'Pull SillyTavern data from GitHub',
        helpText: 'Pull the latest data from the configured GitHub repository and restore it locally.',
    });

    registerSlashCommand('sync-status', cmdStatus, {
        description: 'Check GitHub sync status',
        helpText: 'Display current sync configuration status and recent operation log.',
    });

    // Add settings panel
    const settingsHtml = buildSettingsHtml();
    $('#extensions_settings').append(settingsHtml);
    bindSettingsEvents();

    console.log('[GitHub-Data-Sync] Frontend extension initialized.');
})();