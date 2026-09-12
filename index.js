const path = require('path');
const fs = require('fs-extra');
const gitOps = require('./lib/git-ops');
const syncEngine = require('./lib/sync-engine');
const syncConfig = require('./lib/sync-config');
const backup = require('./lib/backup');
const secrets = require('./lib/secrets');

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
 * 一次性迁移：把配置文件里的明文 token 搬到 0600 密钥文件并清空原字段。
 * 用户无需任何操作：重启后（或首次请求时）自动完成。
 * 迁移失败只提示、不抛错，避免阻断插件启动。
 */
function migrateLegacyToken(saved, handle, configFilePath) {
    try {
        const tokenFile = (typeof saved.tokenFile === 'string' && saved.tokenFile.trim())
            ? saved.tokenFile.trim()
            : secrets.getTokenFilePath(handle);

        const existing = secrets.readTokenFromFile(tokenFile);
        const legacy = typeof saved.githubToken === 'string' ? saved.githubToken.trim() : '';

        if (!legacy) {
            // 没有明文 token：若也没有密钥文件，只在内存里记录默认路径
            if (!existing) saved.tokenFile = tokenFile;
            return;
        }

        if (existing) {
            // 密钥文件已有值：清除配置里的明文副本
            saved.githubToken = '';
            saved.tokenFile = tokenFile;
            try { fs.writeJsonSync(configFilePath, saved, { spaces: 4 }); } catch { /* 回写失败仅提示 */ }
            console.log(`[github-data-sync] 用户 ${handle}: 已清除配置中的明文 token（密钥文件已存在）`);
            return;
        }

        // 主迁移路径：明文 -> 密钥文件 -> 清空原字段
        secrets.writeTokenToFile(tokenFile, legacy);
        saved.githubToken = '';
        saved.tokenFile = tokenFile;
        try { fs.writeJsonSync(configFilePath, saved, { spaces: 4 }); } catch { /* 回写失败仅提示 */ }
        console.log(`[github-data-sync] 用户 ${handle}: token 已自动迁移到密钥文件 ${tokenFile}（配置中的明文已清空）`);
    } catch (err) {
        console.error(`[github-data-sync] token 迁移失败 (用户: ${handle}):`, err.message);
    }
}

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

    // 一次性迁移：明文 token -> 0600 密钥文件（零用户操作）
    migrateLegacyToken(saved, handle, configFilePath);

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
    const merged = syncConfig.mergeWithDefaults(newConfig);

    // 用户刚输入的新 token 也立即落到密钥文件，配置里不保留明文
    if (typeof merged.githubToken === 'string' && merged.githubToken.trim()) {
        try {
            const tokenFile = (typeof merged.tokenFile === 'string' && merged.tokenFile.trim())
                ? merged.tokenFile.trim()
                : secrets.getTokenFilePath(ctx.handle);
            secrets.writeTokenToFile(tokenFile, merged.githubToken.trim());
            merged.githubToken = '';
            merged.tokenFile = tokenFile;
            addLogEntry(ctx, 'info', 'Token 已保存到密钥文件', tokenFile);
        } catch (err) {
            // 密钥文件写入失败时保留原字段，让本次配置仍然可用
            console.error(`[github-data-sync] 写入密钥文件失败 (用户: ${ctx.handle}):`, err.message);
        }
    }

    ctx.config = merged;
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
        // 预拉取：让本地仓库与远端对齐后再推送。
        // 注意：不能无条件吞掉异常 —— 移除 -X ours 之后，冲突会让仓库停留在 merge 状态，
        // 随后的 pushData 会把冲突标记（<<<<<<< / >>>>>>>）当成正常内容提交上去。
        try {
            await gitOps.pullRepo(ctx.config, ctx.syncDir);
        } catch (err) {
            const conflicts = await gitOps.getConflictFiles(ctx.syncDir).catch(() => []);
            if (conflicts.length > 0) {
                await gitOps.abortMerge(ctx.syncDir).catch(() => {});
                throw Object.assign(
                    new Error(`远程有 ${conflicts.length} 个文件与本地冲突，已中止推送。请先执行「拉取」并在冲突面板中处理。`),
                    { statusCode: 409, code: 'PUSH_CONFLICT' }
                );
            }
            // 远端尚无任何提交（首次推送）等情况可以继续
        }

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

        // 拉取前自动备份：备份失败必须中止拉取，否则远端覆盖后本地无法恢复。
        const autoBackupEnabled = ctx.config.autoBackup?.enabled !== false;
        if (autoBackupEnabled) {
            let backupResult;
            try {
                backupResult = await backup.createBackup(ctx.config, ctx.stDataRoot);
            } catch (err) {
                addLogEntry(ctx, 'error', '拉取前备份失败，已中止拉取', err.message);
                throw Object.assign(
                    new Error(`拉取前备份失败，为避免数据丢失已中止：${err.message}`),
                    { statusCode: 500, code: 'BACKUP_FAILED' }
                );
            }
            if (backupResult && backupResult.created) {
                addLogEntry(ctx, 'info', '备份已创建', `${backupResult.categories.length} 个类别, ${backup.formatSize(backupResult.size)}`);
            } else {
                addLogEntry(ctx, 'warning', '未创建备份', `原因: ${backupResult?.reason || 'unknown'}。本次拉取仍会继续。`);
            }
        } else {
            addLogEntry(ctx, 'warning', '拉取前自动备份已关闭', '本次拉取不会创建备份，数据可能无法恢复。');
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
        const git = gitOps.gitWithEnv(undefined, ctx.config);
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

    // ---- Extensions backup route ----

    router.get('/extensions', async (req, res) => {
        try {
            const ctx = getUserContext(req);
            const extDir = path.join(stRoot, 'public', 'scripts', 'extensions', 'third-party');
            const list = [];
            try {
                const entries = await fs.readdir(extDir, { withFileTypes: true });
                for (const entry of entries) {
                    if (!entry.isDirectory()) continue;
                    let url = '(本地扩展)';
                    try {
                        const gitConfig = path.join(extDir, entry.name, '.git', 'config');
                        if (await fs.pathExists(gitConfig)) {
                            const content = await fs.readFile(gitConfig, 'utf-8');
                            const match = content.match(/url\s*=\s*(.*)/);
                            if (match) {
                                // 脱敏：去掉可能内嵌的凭据（https://user:token@host/...）
                                url = match[1].trim().replace(/\/\/[^@/]+@/, '//***@');
                            }
                        }
                    } catch { /* ignore */ }
                    list.push({ name: entry.name, url });
                }
            } catch { /* dir may not exist */ }

            res.json({ success: true, list });
        } catch (err) {
            res.status(500).json({ success: false, error: err.message });
        }
    });

    router.get('/extensions-backup', async (req, res) => {
        try {
            const ctx = getUserContext(req);
            const backupPath = path.join(ctx.stDataRoot, 'extensions-backup.json');
            let list = [];
            if (await fs.pathExists(backupPath)) {
                try { list = await fs.readJson(backupPath); } catch { /* corrupted file */ }
            }
            res.json({ success: true, list: Array.isArray(list) ? list : [] });
        } catch (err) {
            res.status(500).json({ success: false, error: err.message });
        }
    });

    router.post('/extensions-backup', async (req, res) => {
        try {
            const ctx = getUserContext(req);
            const list = req.body?.list;
            if (!Array.isArray(list)) {
                res.status(400).json({ success: false, error: '需要提供 list 数组。' });
                return;
            }
            const backupPath = path.join(ctx.stDataRoot, 'extensions-backup.json');
            await fs.writeJson(backupPath, list, { spaces: 4 });
            addLogEntry(ctx, 'info', '扩展备份已更新', `${list.length} 个扩展`);
            res.json({ success: true, count: list.length });
        } catch (err) {
            res.status(500).json({ success: false, error: err.message });
        }
    });

    // ---- Conflict resolution routes ----

    router.get('/conflicts', async (req, res) => {
        try {
            const ctx = getUserContext(req);
            if (!(await gitOps.isRepo(ctx.syncDir))) {
                res.json({ success: true, conflictFiles: [] });
                return;
            }
            const conflictFiles = await gitOps.getConflictFiles(ctx.syncDir);
            res.json({ success: true, conflictFiles });
        } catch (err) {
            res.status(500).json({ success: false, error: err.message });
        }
    });

    router.get('/conflict-content', async (req, res) => {
        try {
            const ctx = getUserContext(req);
            const file = req.query.file;
            if (!file) {
                res.status(400).json({ success: false, error: '需要提供 file 参数。' });
                return;
            }
            // Security: resolve within syncDir only
            const filePath = path.normalize(path.join(ctx.syncDir, file));
            if (!filePath.startsWith(path.normalize(ctx.syncDir) + path.sep) && filePath !== path.normalize(ctx.syncDir)) {
                res.status(403).json({ success: false, error: '禁止访问。' });
                return;
            }
            if (!(await fs.pathExists(filePath))) {
                res.status(404).json({ success: false, error: '文件不存在。' });
                return;
            }
            const content = await fs.readFile(filePath, 'utf-8');
            res.json({ success: true, file, content });
        } catch (err) {
            res.status(500).json({ success: false, error: err.message });
        }
    });

    router.post('/resolve-conflict', async (req, res) => {
        try {
            const ctx = getUserContext(req);
            if (ctx.syncInProgress) {
                res.status(409).json({ success: false, error: '同步操作正在进行中。' });
                return;
            }
            const { fileName, strategy, content } = req.body || {};
            if (!fileName || !strategy) {
                res.status(400).json({ success: false, error: '需要提供 fileName 和 strategy。' });
                return;
            }
            // Security: resolve within syncDir only
            const filePath = path.normalize(path.join(ctx.syncDir, fileName));
            if (!filePath.startsWith(path.normalize(ctx.syncDir) + path.sep) && filePath !== path.normalize(ctx.syncDir)) {
                res.status(403).json({ success: false, error: '禁止访问。' });
                return;
            }

            if (strategy === 'ours') {
                await gitOps.checkoutOurs(ctx.syncDir, fileName);
            } else if (strategy === 'theirs') {
                await gitOps.checkoutTheirs(ctx.syncDir, fileName);
            } else if (strategy === 'manual') {
                if (content === undefined || content === null) {
                    res.status(400).json({ success: false, error: '手动解决需要提供 content。' });
                    return;
                }
                // JSON validation for .json files
                if (fileName.endsWith('.json')) {
                    try { JSON.parse(content); } catch (e) {
                        res.status(400).json({ success: false, error: 'JSON 格式错误: ' + e.message });
                        return;
                    }
                }
                await fs.writeFile(filePath, content, 'utf-8');
                await gitOps.addFile(ctx.syncDir, fileName);
            } else {
                res.status(400).json({ success: false, error: 'strategy 必须为 ours、theirs 或 manual。' });
                return;
            }

            // 全部冲突解决后：提交，并把结果回写到数据目录
            const remaining = await gitOps.getConflictFiles(ctx.syncDir);
            if (remaining.length === 0) {
                await gitOps.commitResolved(ctx.syncDir, 'Resolve merge conflicts');
                addLogEntry(ctx, 'success', '所有冲突已解决');

                // 冲突解决结果此时只存在于同步仓库的工作区，必须回写到数据目录。
                // 旧实现到此结束，用户"解决完冲突"却在本地看不到任何变化。
                try {
                    const applied = await syncEngine.copyFromRepo(
                        ctx.config,
                        ctx.syncDir,
                        ctx.stDataRoot,
                        (done, total, label) => addLogEntry(ctx, 'info', `应用冲突解决结果: ${label} (${done}/${total})`),
                        { changes: 0, insertions: 0, deletions: 0 }
                    );
                    addLogEntry(ctx, 'success', '冲突解决结果已应用', `${applied.filesRestored.length} 个类别`);
                } catch (err) {
                    addLogEntry(ctx, 'warning', '冲突已解决，但应用到本地失败', err.message);
                }
            }

            res.json({ success: true, remainingConflicts: remaining.length });
        } catch (err) {
            res.status(500).json({ success: false, error: err.message });
        }
    });

    router.post('/force-push', async (req, res) => {
        try {
            const ctx = getUserContext(req);
            if (ctx.syncInProgress) {
                res.status(409).json({ success: false, error: '同步操作正在进行中。' });
                return;
            }
            ctx.syncInProgress = true;
            try {
                await gitOps.resolveAllOurs(ctx.syncDir);
                await gitOps.commitResolved(ctx.syncDir, 'Resolve conflicts: keep local');
                await gitOps.forcePush(ctx.config, ctx.syncDir);
                addLogEntry(ctx, 'success', '已强制推送（保留本地）');
                res.json({ success: true });
            } finally {
                ctx.syncInProgress = false;
            }
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
            if (!result.created) {
                const message = result.reason === 'disabled'
                    ? '自动备份功能已关闭，未创建备份。'
                    : '没有数据需要备份。';
                res.json({ success: true, message });
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
            res.status(err.statusCode || 500).json({ success: false, error: err.message });
        }
    });

    router.delete('/backup/:id', async (req, res) => {
        try {
            const ctx = getUserContext(req);
            await backup.deleteBackup(req.params.id, ctx.stDataRoot);
            addLogEntry(ctx, 'info', '备份已删除', req.params.id);
            res.json({ success: true });
        } catch (err) {
            res.status(err.statusCode || 500).json({ success: false, error: err.message });
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
    // 仅供测试与迁移工具使用
    migrateLegacyToken,
    createUserContext,
};
