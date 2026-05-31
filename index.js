const path = require('path');
const fs = require('fs-extra');
const gitOps = require('./lib/git-ops');
const syncEngine = require('./lib/sync-engine');
const syncConfig = require('./lib/sync-config');
const backup = require('./lib/backup');

const PLUGIN_ID = 'github-data-sync';
const SYNC_DIR_NAME = '.github-data-sync';
const MAX_LOG_ENTRIES = 10;

let config = null;
let syncInProgress = false;
let autoPushTimer = null;
let syncLog = [];
let stDataRoot = '';
let syncDir = '';

function addLogEntry(type, message, details) {
    syncLog.unshift({ type, message, details, timestamp: new Date().toISOString() });
    if (syncLog.length > MAX_LOG_ENTRIES) syncLog = syncLog.slice(0, MAX_LOG_ENTRIES);
}

function loadConfig() {
    let saved = {};
    try {
        if (global.extension_settings && global.extension_settings[PLUGIN_ID]) {
            saved = global.extension_settings[PLUGIN_ID];
        }
    } catch { /* not in ST context */ }
    config = syncConfig.mergeWithDefaults(saved);
}

function saveConfig(newConfig) {
    config = syncConfig.mergeWithDefaults(newConfig);
    try {
        if (global.extension_settings) {
            global.extension_settings[PLUGIN_ID] = config;
        }
    } catch { /* not in ST context */ }
}

function startAutoPush() {
    stopAutoPush();
    if (config.autoPush?.enabled && config.autoPush.intervalMinutes >= 5) {
        const ms = config.autoPush.intervalMinutes * 60 * 1000;
        autoPushTimer = setInterval(() => { executePush().catch(() => {}); }, ms);
    }
}

function stopAutoPush() {
    if (autoPushTimer) { clearInterval(autoPushTimer); autoPushTimer = null; }
}

async function ensureRepo() {
    if (!(await gitOps.isRepo(syncDir))) {
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
        const v = syncConfig.validateConfig(config);
        if (!v.valid) throw Object.assign(new Error(v.errors.join(' ')), { statusCode: 400, code: 'INVALID_CONFIG' });

        await ensureRepo();
        try { await gitOps.pullRepo(config, syncDir); } catch { /* first push may have no remote commits */ }

        const result = await syncEngine.pushData(config, syncDir, stDataRoot);
        if (result.skipped) {
            addLogEntry('info', 'Push skipped - no changes.');
        } else {
            addLogEntry('success', 'Push OK', `${result.filesChanged.length} categories (${(result.commitHash || '').substring(0, 7)})`);
        }
        return result;
    } catch (err) {
        const msg = gitOps.redactToken(err.message);
        addLogEntry('error', 'Push failed', msg);
        throw Object.assign(new Error(msg), { statusCode: err.statusCode || 500, code: err.code || 'PUSH_FAILED' });
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
        const v = syncConfig.validateConfig(config);
        if (!v.valid) throw Object.assign(new Error(v.errors.join(' ')), { statusCode: 400, code: 'INVALID_CONFIG' });

        // Auto-backup before pull
        let backupResult = null;
        if (config.autoBackup?.enabled) {
            try {
                backupResult = await backup.createBackup(config, stDataRoot);
                if (backupResult) {
                    addLogEntry('info', 'Backup created', `${backupResult.categories.length} categories, ${backup.formatSize(backupResult.size)}`);
                }
            } catch (err) {
                addLogEntry('warning', 'Backup failed', err.message);
            }
        }

        await ensureRepo();
        const result = await syncEngine.pullData(config, syncDir, stDataRoot);
        if (result.conflicts?.length > 0) {
            addLogEntry('warning', 'Pull had conflicts', result.conflicts.join(', '));
        } else {
            addLogEntry('success', 'Pull OK', `${result.filesRestored.length} categories restored`);
        }
        return result;
    } catch (err) {
        const msg = gitOps.redactToken(err.message);
        addLogEntry('error', 'Pull failed', msg);
        throw Object.assign(new Error(msg), { statusCode: err.statusCode || 500, code: err.code || 'PULL_FAILED' });
    } finally {
        syncInProgress = false;
    }
}

async function validateConnection() {
    const v = syncConfig.validateConfig(config);
    if (!v.valid) return { valid: false, errors: v.errors };
    try {
        const remoteUrl = gitOps.buildRemoteUrl(config);
        const git = require('simple-git')();
        await git.listRemote(['--heads', remoteUrl]);
        return { valid: true, message: 'Successfully connected to repository.' };
    } catch (err) {
        return { valid: false, errors: [gitOps.redactToken(err.message)] };
    }
}

// ===================== INIT =====================

async function init(router) {
    // ST root is two directories up from this plugin
    const stRoot = path.join(__dirname, '..', '..');
    const publicRoot = path.join(stRoot, 'public');

    // Auto-deploy frontend companion to a SillyTavern extension directory
    const extDir = path.join(publicRoot, 'scripts', 'extensions', 'third-party', 'github-data-sync');
    const clientSourceDir = path.join(__dirname, 'client');
    try {
        await fs.ensureDir(extDir);
        const files = ['index.js', 'manifest.json'];
        for (const file of files) {
            const src = path.join(clientSourceDir, file);
            const dst = path.join(extDir, file);
            let doCopy = true;
            if (await fs.pathExists(dst)) {
                const srcContent = await fs.readFile(src, 'utf-8');
                const dstContent = await fs.readFile(dst, 'utf-8');
                if (srcContent === dstContent) doCopy = false;
            }
            if (doCopy) {
                await fs.copy(src, dst);
                console.log(`[github-data-sync] Deployed -> ${dst}`);
            }
        }
    } catch (err) {
        console.error(`[github-data-sync] Failed to deploy client files:`, err.message);
    }

    // Set data paths
    stDataRoot = path.join(stRoot, 'data', 'default-user');
    syncDir = path.join(stDataRoot, SYNC_DIR_NAME);
    await fs.ensureDir(stDataRoot);

    // Load config and start auto-push if enabled
    loadConfig();
    if (config.autoPush?.enabled) {
        if (syncConfig.validateConfig(config).valid) startAutoPush();
    }

    // ---- Register API routes on the router ----
    // ST mounts these at /api/plugins/github-data-sync

    router.post('/push', async (_req, res) => {
        try {
            const result = await executePush();
            res.json({ success: true, ...result });
        } catch (err) {
            res.status(err.statusCode || 500).json({ success: false, error: err.message, code: err.code || 'UNKNOWN' });
        }
    });

    router.post('/pull', async (_req, res) => {
        try {
            const result = await executePull();
            res.json({ success: true, ...result });
        } catch (err) {
            res.status(err.statusCode || 500).json({ success: false, error: err.message, code: err.code || 'UNKNOWN' });
        }
    });

    router.get('/status', async (_req, res) => {
        try {
            let gitStatus = null;
            if (await gitOps.isRepo(syncDir)) {
                try { gitStatus = await gitOps.getStatus(syncDir); } catch { gitStatus = { error: 'Failed to read git status' }; }
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

    router.get('/config', (_req, res) => {
        res.json({ success: true, config: syncConfig.maskConfig(config) });
    });

    router.put('/config', (req, res) => {
        try {
            const partial = req.body || {};
            const merged = syncConfig.mergeWithDefaults({ ...config, ...partial });
            const v = syncConfig.validateConfig(merged);
            if (!v.valid) { res.status(400).json({ success: false, errors: v.errors }); return; }
            saveConfig(merged);
            startAutoPush();
            res.json({ success: true, config: syncConfig.maskConfig(config) });
        } catch (err) {
            res.status(500).json({ success: false, error: err.message });
        }
    });

    router.get('/validate', async (_req, res) => {
        try {
            const result = await validateConnection();
            res.json({ success: true, ...result });
        } catch (err) {
            res.status(500).json({ success: false, error: err.message });
        }
    });

    router.get('/backups', async (_req, res) => {
        try {
            const backups = await backup.listBackups(stDataRoot);
            const result = backups.map(b => ({
                id: b.id,
                categories: b.categories,
                size: b.size,
                sizeFormatted: backup.formatSize(b.size),
                timestamp: b.timestamp,
            }));
            res.json({ success: true, backups: result });
        } catch (err) {
            res.status(500).json({ success: false, error: err.message });
        }
    });

    router.post('/backup/create', async (_req, res) => {
        try {
            const result = await backup.createBackup(config, stDataRoot);
            if (!result) {
                res.json({ success: true, message: 'No data to back up.' });
                return;
            }
            addLogEntry('info', 'Manual backup created', `${result.categories.length} categories, ${backup.formatSize(result.size)}`);
            res.json({ success: true, ...result, sizeFormatted: backup.formatSize(result.size) });
        } catch (err) {
            res.status(500).json({ success: false, error: err.message });
        }
    });

    router.post('/backup/restore', async (req, res) => {
        try {
            const { backupId } = req.body || {};
            if (!backupId) {
                res.status(400).json({ success: false, error: 'backupId is required.' });
                return;
            }
            const result = await backup.restoreBackup(backupId, config, stDataRoot);
            addLogEntry('success', 'Backup restored', `${result.restored.join(', ')}`);
            res.json({ success: true, ...result });
        } catch (err) {
            res.status(500).json({ success: false, error: err.message });
        }
    });

    router.delete('/backup/:id', async (req, res) => {
        try {
            await backup.deleteBackup(req.params.id, stDataRoot);
            addLogEntry('info', 'Backup deleted', req.params.id);
            res.json({ success: true });
        } catch (err) {
            res.status(500).json({ success: false, error: err.message });
        }
    });

    router.get('/client.js', (_req, res) => {
        const filePath = path.join(__dirname, 'client', 'index.js');
        res.type('application/javascript');
        res.sendFile(filePath);
    });

    console.log(`[github-data-sync] Plugin initialized. Sync dir: ${syncDir}`);
}

async function exit() {
    stopAutoPush();
    syncInProgress = false;
    console.log('[github-data-sync] Plugin exited.');
}

module.exports = {
    info: {
        id: 'github-data-sync',
        name: 'GitHub Data Sync',
        description: 'Sync SillyTavern data (characters, chats, worlds, settings) with a private GitHub repository. Push/pull via slash commands or periodic auto-push.',
    },
    init,
    exit,
};