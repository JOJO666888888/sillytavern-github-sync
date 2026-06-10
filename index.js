const path = require('path');
const fs = require('fs-extra');
const gitOps = require('./lib/git-ops');
const syncEngine = require('./lib/sync-engine');
const syncConfig = require('./lib/sync-config');
const backup = require('./lib/backup');

const PLUGIN_ID = 'github-data-sync';
const SYNC_DIR_NAME = '.github-data-sync';
const MAX_LOG_ENTRIES = 10;
const CONFIG_FILE_NAME = 'github-data-sync-config.json';

// ===================== 多用户上下文管理 =====================

/**
 * 每个用户的运行时上下文。
 * @typedef {Object} UserContext
 * @property {string} handle
 * @property {string} stDataRoot  用户数据根目录
 * @property {string} syncDir     Git 仓库本地路径
 * @property {string} configFilePath  配置文件路径
 * @property {Object} config      合并后的配置
 * @property {Array}  syncLog     同步日志
 * @property {boolean} syncInProgress  操作锁
 * @property {NodeJS.Timeout|null} autoPushTimer  自动推送定时器
 */

/** @type {Map<string, UserContext>} */
const userContexts = new Map();

let stRoot = '';

/**
 * 创建用户的上下文（加载配置）。
 */
function createUserContext(handle, stDataRoot) {
    const syncDir = path.join(stDataRoot, SYNC_DIR_NAME);
    const configFilePath = path.join(stDataRoot, CONFIG_FILE_NAME);

    // 加载配置：优先从独立配置文件读取
    let saved = {};
    try {
        if (configFilePath && fs.existsSync(configFilePath)) {
            saved = fs.readJsonSync(configFilePath);
        }
    } catch { /* ignore */ }
    // 兼容：从 extension_settings 读取
    if (!saved || Object.keys(saved).length === 0) {
        try {
            if (global.extension_settings && global.extension_settings[PLUGIN_ID]) {
                saved = global.extension_settings[PLUGIN_ID];
            }
        } catch { /* not in ST context */ }
    }

    const ctx = {
        handle,
        stDataRoot,
        syncDir,
        configFilePath,
        config: syncConfig.mergeWithDefaults(saved),
        syncLog: [],
        syncInProgress: false,
        autoPushTimer: null,
    };

    userContexts.set(handle, ctx);
    return ctx;
}

/**
 * 从请求对象获取当前用户的上下文（延迟创建）。
 */
function getUserContext(req) {
    const handle = req.user?.profile?.handle || 'default-user';
    const existing = userContexts.get(handle);
    if (existing) return existing;

    const stDataRoot = req.user?.directories?.root || path.join(stRoot, 'data', handle);
    return createUserContext(handle, stDataRoot);
}

function addLogEntry(ctx, type, message, details) {
    ctx.syncLog.unshift({ type, message, details, timestamp: new Date().toISOString() });
    if (ctx.syncLog.length > MAX_LOG_ENTRIES) ctx.syncLog = ctx.syncLog.slice(0, MAX_LOG_ENTRIES);
}

function saveConfig(ctx, newConfig) {
    ctx.config = syncConfig.mergeWithDefaults(newConfig);
    // 写入 extension_settings（兼容 ST 内存存储）
    try {
        if (global.extension_settings) {
            global.extension_settings[PLUGIN_ID] = ctx.config;
        }
    } catch { /* not in ST context */ }
    // 写入独立配置文件（持久化存储）
    try {
        if (ctx.configFilePath) {
            fs.writeJsonSync(ctx.configFilePath, ctx.config, { spaces: 4 });
        }
    } catch (err) {
        console.error(`[github-data-sync] 配置保存失败 (用户: ${ctx.handle}):`, err.message);
    }
}

function startAutoPush(ctx) {
    stopAutoPush(ctx);
    if (ctx.config.autoPush?.enabled && ctx.config.autoPush.intervalMinutes >= 5) {
        const ms = ctx.config.autoPush.intervalMinutes * 60 * 1000;
        ctx.autoPushTimer = setInterval(() => { executePush(ctx).catch(() => {}); }, ms);
    }
}

function stopAutoPush(ctx) {
    if (ctx.autoPushTimer) {
        clearInterval(ctx.autoPushTimer);
        ctx.autoPushTimer = null;
    }
}

// ===================== Git 操作 =====================

async function ensureRepo(ctx) {
    if (!(await gitOps.isRepo(ctx.syncDir))) {
        await gitOps.cloneRepo(ctx.config, ctx.syncDir);
        addLogEntry(ctx, 'info', '仓库已克隆。');
    }
}

async function executePush(ctx) {
    if (ctx.syncInProgress) {
        throw Object.assign(new Error('同步操作正在进行中。'), { statusCode: 409, code: 'LOCKED' });
    }
    ctx.syncInProgress = true;
    try {
        const v = syncConfig.validateConfig(ctx.config);
        if (!v.valid) throw Object.assign(new Error(v.errors.join(' ')), { statusCode: 400, code: 'INVALID_CONFIG' });

        await ensureRepo(ctx);
        try { await gitOps.pullRepo(ctx.config, ctx.syncDir); } catch { /* first push may have no remote commits */ }

        const onProgress = (done, total, label) => {
            addLogEntry(ctx, 'info', `推送中: ${label} (${done}/${total})`);
        };
        const result = await syncEngine.pushData(ctx.config, ctx.syncDir, ctx.stDataRoot, onProgress);
        if (result.skipped) {
            addLogEntry(ctx, 'info', '推送已跳过 — 没有更改。');
        } else {
            addLogEntry(ctx, 'success', '推送成功', `${result.filesChanged.length} 个类别 (${(result.commitHash || '').substring(0, 7)})`);
        }
        return result;
    } catch (err) {
        const msg = gitOps.redactToken(err.message);
        addLogEntry(ctx, 'error', '推送失败', msg);
        throw Object.assign(new Error(msg), { statusCode: err.statusCode || 500, code: err.code || 'PUSH_FAILED' });
    } finally {
        ctx.syncInProgress = false;
    }
}

async function executePull(ctx) {
    if (ctx.syncInProgress) {
        throw Object.assign(new Error('同步操作正在进行中。'), { statusCode: 409, code: 'LOCKED' });
    }
    ctx.syncInProgress = true;
    try {
        const v = syncConfig.validateConfig(ctx.config);
        if (!v.valid) throw Object.assign(new Error(v.errors.join(' ')), { statusCode: 400, code: 'INVALID_CONFIG' });

        // Auto-backup before pull
        let backupResult = null;
        if (ctx.config.autoBackup?.enabled) {
            try {
                backupResult = await backup.createBackup(ctx.config, ctx.stDataRoot);
                if (backupResult) {
                    addLogEntry(ctx, 'info', '备份已创建', `${backupResult.categories.length} 个类别, ${backup.formatSize(backupResult.size)}`);
                }
            } catch (err) {
                addLogEntry(ctx, 'warning', '备份失败', err.message);
            }
        }

        await ensureRepo(ctx);
        const onProgress = (done, total, label) => {
            addLogEntry(ctx, 'info', `拉取中: ${label} (${done}/${total})`);
        };
        const result = await syncEngine.pullData(ctx.config, ctx.syncDir, ctx.stDataRoot, onProgress);
        if (result.conflicts?.length > 0) {
            addLogEntry(ctx, 'warning', '拉取有冲突', result.conflicts.join(', '));
        } else {
            addLogEntry(ctx, 'success', '拉取成功', `${result.filesRestored.length} 个类别已恢复`);
        }
        return result;
    } catch (err) {
        const msg = gitOps.redactToken(err.message);
        addLogEntry(ctx, 'error', '拉取失败', msg);
        throw Object.assign(new Error(msg), { statusCode: err.statusCode || 500, code: err.code || 'PULL_FAILED' });
    } finally {
        ctx.syncInProgress = false;
    }
}

async function validateConnection(ctx) {
    const v = syncConfig.validateConfig(ctx.config);
    if (!v.valid) return { valid: false, errors: v.errors };
    try {
        const remoteUrl = gitOps.buildRemoteUrl(ctx.config);
        const git = require('simple-git')();
        await git.listRemote(['--heads', remoteUrl]);
        return { valid: true, message: '已成功连接到仓库。' };
    } catch (err) {
        return { valid: false, errors: [gitOps.redactToken(err.message)] };
    }
}

// ===================== INIT =====================

async function init(router) {
    stRoot = path.join(__dirname, '..', '..');
    const publicRoot = path.join(stRoot, 'public');

    // Auto-deploy frontend companion
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

    // 扫描已有用户目录，初始化上下文并恢复自动推送
    const dataDir = path.join(stRoot, 'data');
    try {
        const entries = await fs.readdir(dataDir);
        for (const entry of entries) {
            if (entry.startsWith('_') || entry.startsWith('.')) continue;
            const userDataRoot = path.join(dataDir, entry);
            try {
                const stat = await fs.stat(userDataRoot);
                if (!stat.isDirectory()) continue;
            } catch { continue; }

            const cfgPath = path.join(userDataRoot, CONFIG_FILE_NAME);
            if (await fs.pathExists(cfgPath)) {
                const ctx = createUserContext(entry, userDataRoot);
                addLogEntry(ctx, 'info', '插件已初始化');
                if (ctx.config.autoPush?.enabled && syncConfig.validateConfig(ctx.config).valid) {
                    startAutoPush(ctx);
                    console.log(`[github-data-sync] 已为用户 ${entry} 恢复自动推送`);
                }
                console.log(`[github-data-sync] 已加载用户 ${entry} 的配置`);
            }
        }
    } catch (err) {
        console.log('[github-data-sync] 扫描用户目录时跳过:', err.message);
    }

    // ---- Register API routes ----
    // ST mounts these at /api/plugins/github-data-sync

    router.post('/push', async (req, res) => {
        try {
            const ctx = getUserContext(req);
            const result = await executePush(ctx);
            res.json({ success: true, ...result });
        } catch (err) {
            res.status(err.statusCode || 500).json({ success: false, error: err.message, code: err.code || 'UNKNOWN' });
        }
    });

    router.post('/pull', async (req, res) => {
        try {
            const ctx = getUserContext(req);
            const result = await executePull(ctx);
            res.json({ success: true, ...result });
        } catch (err) {
            res.status(err.statusCode || 500).json({ success: false, error: err.message, code: err.code || 'UNKNOWN' });
        }
    });

    router.get('/status', async (req, res) => {
        try {
            const ctx = getUserContext(req);
            let gitStatus = null;
            if (await gitOps.isRepo(ctx.syncDir)) {
                try { gitStatus = await gitOps.getStatus(ctx.syncDir); } catch { gitStatus = { error: '读取 git 状态失败' }; }
            }
            res.json({
                success: true,
                syncInProgress: ctx.syncInProgress,
                configValid: syncConfig.validateConfig(ctx.config).valid,
                autoPushEnabled: ctx.config.autoPush?.enabled || false,
                autoPushInterval: ctx.config.autoPush?.intervalMinutes || 0,
                gitStatus,
                syncLog: ctx.syncLog.slice(0, MAX_LOG_ENTRIES),
            });
        } catch (err) {
            res.status(500).json({ success: false, error: err.message });
        }
    });

    router.get('/config', (req, res) => {
        const ctx = getUserContext(req);
        res.json({ success: true, config: syncConfig.maskConfig(ctx.config) });
    });

    router.put('/config', (req, res) => {
        try {
            const ctx = getUserContext(req);
            const partial = req.body || {};
            // 如果 token 为空或脱敏值（全是星号），保留原有 token
            if (!partial.githubToken || /^\*+$/.test(partial.githubToken)) {
                delete partial.githubToken;
            }
            const merged = syncConfig.mergeWithDefaults({ ...ctx.config, ...partial });
            const v = syncConfig.validateConfig(merged);
            if (!v.valid) { res.status(400).json({ success: false, errors: v.errors }); return; }
            saveConfig(ctx, merged);
            startAutoPush(ctx);
            res.json({ success: true, config: syncConfig.maskConfig(ctx.config) });
        } catch (err) {
            res.status(500).json({ success: false, error: err.message });
        }
    });

    router.get('/validate', async (req, res) => {
        try {
            const ctx = getUserContext(req);
            const result = await validateConnection(ctx);
            res.json({ success: true, ...result });
        } catch (err) {
            res.status(500).json({ success: false, error: err.message });
        }
    });

    router.get('/backups', async (req, res) => {
        try {
            const ctx = getUserContext(req);
            const backups = await backup.listBackups(ctx.stDataRoot);
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

    router.post('/backup/create', async (req, res) => {
        try {
            const ctx = getUserContext(req);
            const result = await backup.createBackup(ctx.config, ctx.stDataRoot);
            if (!result) {
                res.json({ success: true, message: '没有数据需要备份。' });
                return;
            }
            addLogEntry(ctx, 'info', '手动备份已创建', `${result.categories.length} 个类别, ${backup.formatSize(result.size)}`);
            res.json({ success: true, ...result, sizeFormatted: backup.formatSize(result.size) });
        } catch (err) {
            res.status(500).json({ success: false, error: err.message });
        }
    });

    router.post('/backup/restore', async (req, res) => {
        try {
            const ctx = getUserContext(req);
            const { backupId } = req.body || {};
            if (!backupId) {
                res.status(400).json({ success: false, error: '需要提供 backupId。' });
                return;
            }
            const result = await backup.restoreBackup(backupId, ctx.config, ctx.stDataRoot);
            addLogEntry(ctx, 'success', '备份已恢复', result.restored.join(', '));
            res.json({ success: true, ...result });
        } catch (err) {
            res.status(500).json({ success: false, error: err.message });
        }
    });

    router.delete('/backup/:id', async (req, res) => {
        try {
            const ctx = getUserContext(req);
            await backup.deleteBackup(req.params.id, ctx.stDataRoot);
            addLogEntry(ctx, 'info', '备份已删除', req.params.id);
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

    console.log(`[github-data-sync] 插件已初始化。数据目录: ${dataDir}`);
}

async function exit() {
    for (const ctx of userContexts.values()) {
        stopAutoPush(ctx);
        ctx.syncInProgress = false;
    }
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
