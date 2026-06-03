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
let configFilePath = '';

function addLogEntry(type, message, details) {
    syncLog.unshift({ type, message, details, timestamp: new Date().toISOString() });
    if (syncLog.length > MAX_LOG_ENTRIES) syncLog = syncLog.slice(0, MAX_LOG_ENTRIES);
}

function loadConfig() {
    let saved = {};
    let fromFile = false;
    // 优先从独立配置文件读取（持久化存储）
    try {
        if (configFilePath && fs.existsSync(configFilePath)) {
            saved = fs.readJsonSync(configFilePath);
            fromFile = true;
        }
    } catch { /* ignore */ }
    // 兼容：如果配置文件不存在，尝试从 extension_settings 读取
    if (!saved || Object.keys(saved).length === 0) {
        try {
            if (global.extension_settings && global.extension_settings[PLUGIN_ID]) {
                saved = global.extension_settings[PLUGIN_ID];
            }
        } catch { /* not in ST context */ }
    }
    config = syncConfig.mergeWithDefaults(saved);
    // 迁移兼容：从内存读到配置且文件不存在时，写入文件
    if (!fromFile && config.githubToken && config.githubRepo) {
        try {
            if (configFilePath) fs.writeJsonSync(configFilePath, config, { spaces: 4 });
            console.log('[github-data-sync] 配置已从内存迁移到文件');
        } catch { /* ignore */ }
    }
}

function saveConfig(newConfig) {
    config = syncConfig.mergeWithDefaults(newConfig);
    // 同时写入 extension_settings（内存）和独立配置文件（持久化）
    try {
        if (global.extension_settings) {
            global.extension_settings[PLUGIN_ID] = config;
        }
    } catch { /* not in ST context */ }
    try {
        if (configFilePath) {
            fs.writeJsonSync(configFilePath, config, { spaces: 4 });
        }
    } catch (err) {
        console.error('[github-data-sync] 配置保存失败:', err.message);
    }
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
        addLogEntry('info', '仓库已克隆。');
    }
}

async function executePush() {
    if (syncInProgress) {
        throw Object.assign(new Error('同步操作正在进行中。'), { statusCode: 409, code: 'LOCKED' });
    }
    syncInProgress = true;
    try {
        const v = syncConfig.validateConfig(config);
        if (!v.valid) throw Object.assign(new Error(v.errors.join(' ')), { statusCode: 400, code: 'INVALID_CONFIG' });

        await ensureRepo();
        try { await gitOps.pullRepo(config, syncDir); } catch { /* first push may have no remote commits */ }

        const onProgress = (done, total, label) => {
            addLogEntry('info', `推送中: ${label} (${done}/${total})`);
        };
        const result = await syncEngine.pushData(config, syncDir, stDataRoot, onProgress);
        if (result.skipped) {
            addLogEntry('info', '推送已跳过 — 没有更改。');
        } else {
            addLogEntry('success', '推送成功', `${result.filesChanged.length} 个类别 (${(result.commitHash || '').substring(0, 7)})`);
        }
        return result;
    } catch (err) {
        const msg = gitOps.redactToken(err.message);
        addLogEntry('error', '推送失败', msg);
        throw Object.assign(new Error(msg), { statusCode: err.statusCode || 500, code: err.code || 'PUSH_FAILED' });
    } finally {
        syncInProgress = false;
    }
}

async function executePull() {
    if (syncInProgress) {
        throw Object.assign(new Error('同步操作正在进行中。'), { statusCode: 409, code: 'LOCKED' });
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
                    addLogEntry('info', '备份已创建', `${backupResult.categories.length} 个类别, ${backup.formatSize(backupResult.size)}`);
                }
            } catch (err) {
                addLogEntry('warning', '备份失败', err.message);
            }
        }

        await ensureRepo();
        const onProgress = (done, total, label) => {
            addLogEntry('info', `拉取中: ${label} (${done}/${total})`);
        };
        const result = await syncEngine.pullData(config, syncDir, stDataRoot, onProgress);
        if (result.conflicts?.length > 0) {
            addLogEntry('warning', '拉取有冲突', result.conflicts.join(', '));
        } else {
            addLogEntry('success', '拉取成功', `${result.filesRestored.length} 个类别已恢复`);
        }
        return result;
    } catch (err) {
        const msg = gitOps.redactToken(err.message);
        addLogEntry('error', '拉取失败', msg);
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
        return { valid: true, message: '已成功连接到仓库。' };
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
                console.log(`[github-data-sync] 部署 -> ${dst}`);
            }
        }
    } catch (err) {
        console.error(`[github-data-sync] 部署客户端文件失败:`, err.message);
    }

    // Set data paths
    stDataRoot = path.join(stRoot, 'data', 'default-user');
    syncDir = path.join(stDataRoot, SYNC_DIR_NAME);
    configFilePath = path.join(stDataRoot, 'github-data-sync-config.json');
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
                try { gitStatus = await gitOps.getStatus(syncDir); } catch { gitStatus = { error: '读取 git 状态失败' }; }
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
            // 如果 token 为空或脱敏值（全是星号），保留原有 token
            if (!partial.githubToken || /^\*+$/.test(partial.githubToken)) {
                delete partial.githubToken;
            }
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
                res.json({ success: true, message: '没有数据需要备份。' });
                return;
            }
            addLogEntry('info', '手动备份已创建', `${result.categories.length} 个类别, ${backup.formatSize(result.size)}`);
            res.json({ success: true, ...result, sizeFormatted: backup.formatSize(result.size) });
        } catch (err) {
            res.status(500).json({ success: false, error: err.message });
        }
    });

    router.post('/backup/restore', async (req, res) => {
        try {
            const { backupId } = req.body || {};
            if (!backupId) {
                res.status(400).json({ success: false, error: '需要提供 backupId。' });
                return;
            }
            const result = await backup.restoreBackup(backupId, config, stDataRoot);
            addLogEntry('success', '备份已恢复', result.restored.join(', '));
            res.json({ success: true, ...result });
        } catch (err) {
            res.status(500).json({ success: false, error: err.message });
        }
    });

    router.delete('/backup/:id', async (req, res) => {
        try {
            await backup.deleteBackup(req.params.id, stDataRoot);
            addLogEntry('info', '备份已删除', req.params.id);
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

    console.log(`[github-data-sync] 插件已初始化。同步目录: ${syncDir}`);
}

async function exit() {
    stopAutoPush();
    syncInProgress = false;
    console.log('[github-data-sync] 插件已退出。');
}

module.exports = {
    info: {
        id: 'github-data-sync',
        name: 'GitHub Data Sync',
        description: '将 SillyTavern 数据（角色卡、聊天、世界书、设置等）同步到 GitHub 私有仓库。',
    },
    init,
    exit,
};
