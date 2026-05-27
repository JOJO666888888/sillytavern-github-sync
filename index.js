const path = require('path');
const fs = require('fs-extra');
const EventEmitter = require('events');
const gitOps = require('./lib/git-ops');
const syncEngine = require('./lib/sync-engine');
const syncConfig = require('./lib/sync-config');

const PLUGIN_NAME = 'github-data-sync';
const SYNC_DIR_NAME = '.github-data-sync';
const MAX_LOG_ENTRIES = 10;

let config = null;
let syncInProgress = false;
let autoPushTimer = null;
let syncLog = [];
let stDataRoot = '';
let syncDir = '';

function addLogEntry(type, message, details) {
    syncLog.unshift({
        type,
        message,
        details,
        timestamp: new Date().toISOString(),
    });
    if (syncLog.length > MAX_LOG_ENTRIES) {
        syncLog = syncLog.slice(0, MAX_LOG_ENTRIES);
    }
}

function loadConfig() {
    // Read from SillyTavern's extension_settings if available
    let saved = {};
    try {
        // In SillyTavern, extension settings are stored globally
        if (global.extension_settings && global.extension_settings[PLUGIN_NAME]) {
            saved = global.extension_settings[PLUGIN_NAME];
        }
    } catch {
        // Not running in SillyTavern context
    }
    config = syncConfig.mergeWithDefaults(saved);
}

function saveConfig(newConfig) {
    config = syncConfig.mergeWithDefaults(newConfig);
    try {
        if (global.extension_settings) {
            global.extension_settings[PLUGIN_NAME] = config;
        }
    } catch {
        // Not running in SillyTavern context
    }
}

function startAutoPush() {
    stopAutoPush();
    if (config.autoPush && config.autoPush.enabled && config.autoPush.intervalMinutes >= 5) {
        const intervalMs = config.autoPush.intervalMinutes * 60 * 1000;
        autoPushTimer = setInterval(() => {
            executePush().catch(() => {
                // Errors logged inside executePush
            });
        }, intervalMs);
    }
}

function stopAutoPush() {
    if (autoPushTimer) {
        clearInterval(autoPushTimer);
        autoPushTimer = null;
    }
}

async function ensureRepo() {
    const isRepo = await gitOps.isRepo(syncDir);
    if (!isRepo) {
        await gitOps.cloneRepo(config, syncDir);
        addLogEntry('info', 'Repository cloned successfully.');
    }
}

async function executePush() {
    if (syncInProgress) {
        throw Object.assign(new Error('A sync operation is already in progress.'), { statusCode: 409, code: 'LOCKED' });
    }

    syncInProgress = true;
    try {
        const validation = syncConfig.validateConfig(config);
        if (!validation.valid) {
            throw Object.assign(new Error(validation.errors.join(' ')), { statusCode: 400, code: 'INVALID_CONFIG' });
        }

        await ensureRepo();

        // Pull first to avoid conflicts
        try {
            await gitOps.pullRepo(config, syncDir);
        } catch {
            // If pull fails (e.g. no remote commits yet), continue
        }

        const result = await syncEngine.pushData(config, syncDir, stDataRoot);

        if (result.skipped) {
            addLogEntry('info', 'Push skipped', 'No changes detected.');
        } else {
            addLogEntry('success', 'Push successful', `${result.filesChanged.length} categories: ${result.filesChanged.join(', ')} (${result.commitHash?.substring(0, 7) || ''})`);
        }

        return result;
    } catch (err) {
        const safeMsg = gitOps.redactToken(err.message);
        addLogEntry('error', 'Push failed', safeMsg);
        throw Object.assign(new Error(safeMsg), { statusCode: err.statusCode || 500, code: err.code || 'PUSH_FAILED' });
    } finally {
        syncInProgress = false;
    }
}

async function executePull() {
    if (syncInProgress) {
        throw Object.assign(new Error('A sync operation is already in progress.'), { statusCode: 409, code: 'LOCKED' });
    }

    syncInProgress = true;
    try {
        const validation = syncConfig.validateConfig(config);
        if (!validation.valid) {
            throw Object.assign(new Error(validation.errors.join(' ')), { statusCode: 400, code: 'INVALID_CONFIG' });
        }

        await ensureRepo();
        const result = await syncEngine.pullData(config, syncDir, stDataRoot);

        if (result.conflicts && result.conflicts.length > 0) {
            addLogEntry('warning', 'Pull completed with conflicts', `Conflicts in: ${result.conflicts.join(', ')}`);
        } else {
            addLogEntry('success', 'Pull successful', `${result.filesRestored.length} categories restored`);
        }

        return result;
    } catch (err) {
        const safeMsg = gitOps.redactToken(err.message);
        addLogEntry('error', 'Pull failed', safeMsg);
        throw Object.assign(new Error(safeMsg), { statusCode: err.statusCode || 500, code: err.code || 'PULL_FAILED' });
    } finally {
        syncInProgress = false;
    }
}

async function validateConnection() {
    const validation = syncConfig.validateConfig(config);
    if (!validation.valid) {
        return { valid: false, errors: validation.errors };
    }

    try {
        // Try to list remote refs to verify token and repo
        const remoteUrl = gitOps.buildRemoteUrl(config);
        const git = require('simple-git')();
        await git.listRemote(['--heads', remoteUrl]);
        return { valid: true, message: 'Successfully connected to repository.' };
    } catch (err) {
        const safeMsg = gitOps.redactToken(err.message);
        return { valid: false, errors: [safeMsg] };
    }
}

function registerEndpoint(app) {
    app.post('/api/plugins/github-data-sync/push', async (req, res) => {
        try {
            const result = await executePush();
            res.json({ success: true, ...result });
        } catch (err) {
            res.status(err.statusCode || 500).json({
                success: false,
                error: err.message,
                code: err.code || 'UNKNOWN',
            });
        }
    });

    app.post('/api/plugins/github-data-sync/pull', async (req, res) => {
        try {
            const result = await executePull();
            res.json({ success: true, ...result });
        } catch (err) {
            res.status(err.statusCode || 500).json({
                success: false,
                error: err.message,
                code: err.code || 'UNKNOWN',
            });
        }
    });

    app.get('/api/plugins/github-data-sync/status', async (req, res) => {
        try {
            let gitStatus = null;
            if (await gitOps.isRepo(syncDir)) {
                try {
                    gitStatus = await gitOps.getStatus(syncDir);
                } catch {
                    gitStatus = { error: 'Failed to read git status' };
                }
            }

            res.json({
                success: true,
                syncInProgress,
                configValid: syncConfig.validateConfig(config).valid,
                autoPushEnabled: config.autoPush?.enabled || false,
                autoPushInterval: config.autoPush?.intervalMinutes || 0,
                gitStatus,
                syncLog: syncLog.slice(0, MAX_LOG_ENTRIES),
            });
        } catch (err) {
            res.status(500).json({ success: false, error: err.message });
        }
    });

    app.get('/api/plugins/github-data-sync/config', (req, res) => {
        res.json({
            success: true,
            config: syncConfig.maskConfig(config),
        });
    });

    app.put('/api/plugins/github-data-sync/config', (req, res) => {
        try {
            const partial = req.body || {};
            const merged = syncConfig.mergeWithDefaults({ ...config, ...partial });
            const validation = syncConfig.validateConfig(merged);

            if (!validation.valid) {
                res.status(400).json({ success: false, errors: validation.errors });
                return;
            }

            saveConfig(merged);
            startAutoPush();
            res.json({ success: true, config: syncConfig.maskConfig(config) });
        } catch (err) {
            res.status(500).json({ success: false, error: err.message });
        }
    });

    app.get('/api/plugins/github-data-sync/validate', async (req, res) => {
        try {
            const result = await validateConnection();
            res.json({ success: true, ...result });
        } catch (err) {
            res.status(500).json({ success: false, error: err.message });
        }
    });

    app.get('/api/plugins/github-data-sync/client.js', (req, res) => {
        const clientPath = path.join(__dirname, 'client', 'index.js');
        res.type('application/javascript');
        res.sendFile(clientPath);
    });
}

async function init(sillyTavern) {
    // Determine ST data root - default to data/default-user
    if (sillyTavern && sillyTavern.getDataRoot) {
        stDataRoot = sillyTavern.getDataRoot();
    } else {
        stDataRoot = path.join(process.cwd(), 'data', 'default-user');
    }

    syncDir = path.join(stDataRoot, SYNC_DIR_NAME);
    await fs.ensureDir(stDataRoot);

    loadConfig();

    if (config.autoPush && config.autoPush.enabled) {
        const validation = syncConfig.validateConfig(config);
        if (validation.valid) {
            startAutoPush();
        }
    }

    console.log(`[${PLUGIN_NAME}] Plugin initialized. Sync dir: ${syncDir}`);
}

async function dispose() {
    stopAutoPush();
    syncInProgress = false;
    console.log(`[${PLUGIN_NAME}] Plugin disposed.`);
}

module.exports = {
    init,
    dispose,
    registerEndpoint,
};