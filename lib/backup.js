const path = require('path');
const fs = require('fs-extra');
const crypto = require('crypto');
const dataLayout = require('./data-layout');

const BACKUP_DIR_NAME = 'backups/github-sync';

// 备份目录名由 createBackup 生成，格式固定为 2026-09-12T07-39-59（秒级 UTC 时间戳）
const BACKUP_ID_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}$/;

// 每个备份目录内的元数据文件，记录内容指纹。
// 用于跳过「数据完全没变」的重复备份 —— 一次备份实测可达 359 MB，
// 若每次拉取都无脑全量复制，纯属浪费时间和磁盘。
const META_FILE_NAME = 'meta.json';

// 备份总体积上限（MB）。这是数量上限之外的第二道闸门：
// 只按份数裁剪无法约束磁盘占用（5 份 x 359 MB ≈ 1.8 GB）。
const DEFAULT_MAX_TOTAL_SIZE_MB = 2048;

function getBackupRoot(stDataRoot) {
    return path.join(stDataRoot, BACKUP_DIR_NAME);
}

/**
 * 把用户传入的 backupId 解析为备份目录的绝对路径。
 *
 * 必须同时通过「格式校验」和「越界校验」：仅做 path.join 时，形如
 * `../../../../` 的 backupId 会逃逸出 backupRoot，而调用方随后会对其执行
 * fs.remove（递归删除）或 fs.copy（覆盖写入）。
 *
 * @param {string} backupId
 * @param {string} stDataRoot
 * @returns {string} 备份目录绝对路径
 */
function resolveBackupDir(backupId, stDataRoot) {
    if (typeof backupId !== 'string' || !BACKUP_ID_PATTERN.test(backupId)) {
        throw Object.assign(new Error(`无效的备份 ID: ${backupId}`), { statusCode: 400 });
    }

    const backupRoot = path.resolve(getBackupRoot(stDataRoot));
    const backupDir = path.resolve(backupRoot, backupId);

    if (!backupDir.startsWith(backupRoot + path.sep)) {
        throw Object.assign(new Error('备份路径越界，已拒绝。'), { statusCode: 400 });
    }

    return backupDir;
}

/**
 * 统计一棵目录树（或单个文件）的文件数、总字节数与最新修改时间。
 * 只做 stat、不读内容，成本远低于一次全量复制 —— 这是指纹方案可行的前提。
 */
async function statTree(rootPath) {
    const st = await fs.stat(rootPath);
    if (st.isFile()) {
        return { files: 1, bytes: st.size, latestMtime: Math.floor(st.mtimeMs) };
    }

    let files = 0;
    let bytes = 0;
    let latestMtime = 0;

    const walk = async (p) => {
        const entries = await fs.readdir(p, { withFileTypes: true });
        for (const entry of entries) {
            const fp = path.join(p, entry.name);
            if (entry.isDirectory()) {
                await walk(fp);
            } else if (entry.isFile()) {
                const fst = await fs.stat(fp);
                files++;
                bytes += fst.size;
                if (fst.mtimeMs > latestMtime) latestMtime = fst.mtimeMs;
            }
        }
    };

    await walk(rootPath);
    return { files, bytes, latestMtime: Math.floor(latestMtime) };
}

/**
 * 生成当前待备份内容的内容指纹。
 * 指纹只依赖「类别 + 文件数 + 总字节 + 最新 mtime」，不做内容哈希，
 * 因此不能用于安全比对，只用于判断「有没有必要再复制一份」。
 */
async function computeFingerprint(config, stDataRoot) {
    const parts = [];
    for (const category of dataLayout.CATEGORIES) {
        if (!config.dataSelection[category]) continue;
        const sourcePath = dataLayout.getSourcePath(category, stDataRoot);
        if (!(await fs.pathExists(sourcePath))) continue;
        const { files, bytes, latestMtime } = await statTree(sourcePath);
        parts.push(`${category}:${files}:${bytes}:${latestMtime}`);
    }
    return crypto.createHash('sha256').update(parts.join('|')).digest('hex').slice(0, 16);
}

async function readMeta(backupDir) {
    try {
        const p = path.join(backupDir, META_FILE_NAME);
        if (!(await fs.pathExists(p))) return null;
        return await fs.readJson(p);
    } catch {
        return null;
    }
}

/** 取最新的一个备份（只读元数据，不做整目录遍历） */
async function getNewestBackup(backupRoot) {
    if (!(await fs.pathExists(backupRoot))) return null;

    const entries = await fs.readdir(backupRoot, { withFileTypes: true });
    const names = entries
        .filter(e => e.isDirectory() && BACKUP_ID_PATTERN.test(e.name))
        .map(e => e.name)
        .sort((a, b) => b.localeCompare(a));

    if (names.length === 0) return null;

    const dir = path.join(backupRoot, names[0]);
    return { id: names[0], path: dir, meta: await readMeta(dir) };
}

async function createBackup(config, stDataRoot) {
    // 区分「功能被关闭」与「没有数据可备份」。
    // 旧实现两者都返回 null，调用方无法分辨，也无法给出任何提示。
    if (!config.autoBackup?.enabled) {
        return { created: false, reason: 'disabled', categories: [], size: 0 };
    }

    const backupRoot = getBackupRoot(stDataRoot);

    // 去重：内容与最新备份一致就完全跳过复制（实测一次约 359 MB / 716 ms）
    const fingerprint = await computeFingerprint(config, stDataRoot);
    const newest = await getNewestBackup(backupRoot);
    if (newest?.meta?.fingerprint && newest.meta.fingerprint === fingerprint) {
        return {
            created: false,
            reason: 'unchanged',
            fingerprint,
            categories: newest.meta.categories || [],
            size: newest.meta.size || 0,
        };
    }

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').substring(0, 19);
    const backupDir = path.join(backupRoot, timestamp);
    await fs.ensureDir(backupDir);

    const backedUp = [];
    let totalSize = 0;

    for (const category of dataLayout.CATEGORIES) {
        if (!config.dataSelection[category]) continue;
        const sourcePath = dataLayout.getSourcePath(category, stDataRoot);
        if (!(await fs.pathExists(sourcePath))) continue;

        const stat = await fs.stat(sourcePath);
        const destPath = path.join(backupDir, path.basename(sourcePath));
        await fs.copy(sourcePath, destPath);
        backedUp.push(category);
        totalSize += stat.isDirectory() ? await dirSize(sourcePath) : stat.size;
    }

    if (backedUp.length === 0) {
        await fs.remove(backupDir);
        return { created: false, reason: 'no-data', categories: [], size: 0 };
    }

    // 写入元数据，供下次去重判断
    try {
        await fs.writeJson(path.join(backupDir, META_FILE_NAME), {
            fingerprint,
            categories: backedUp,
            size: totalSize,
            createdAt: new Date().toISOString(),
        }, { spaces: 4 });
    } catch { /* 元数据写入失败不影响备份本身 */ }

    const maxBackups = config.autoBackup?.maxBackups || 5;
    const maxTotalSizeMB = Number.isFinite(config.autoBackup?.maxTotalSizeMB)
        ? config.autoBackup.maxTotalSizeMB
        : DEFAULT_MAX_TOTAL_SIZE_MB;
    const prune = await cleanupOldBackups(backupRoot, maxBackups, maxTotalSizeMB);

    return {
        created: true,
        id: timestamp,
        path: backupDir,
        categories: backedUp,
        size: totalSize,
        fingerprint,
        pruned: prune.removed,
        totalBackupSize: prune.totalSize,
        timestamp: new Date().toISOString(),
    };
}

async function listBackups(stDataRoot) {
    const backupRoot = getBackupRoot(stDataRoot);
    if (!(await fs.pathExists(backupRoot))) return [];

    const entries = await fs.readdir(backupRoot, { withFileTypes: true });
    const backups = [];

    for (const entry of entries) {
        if (!entry.isDirectory() || !BACKUP_ID_PATTERN.test(entry.name)) continue;
        const backupPath = path.join(backupRoot, entry.name);
        const files = await fs.readdir(backupPath);
        const categories = files
            .filter(f => f !== META_FILE_NAME)
            .map(f => {
                // 把文件/目录名映射回类别
                const cat = dataLayout.CATEGORIES.find(c => {
                    const src = dataLayout.getSourcePath(c, '');
                    return path.basename(src) === f;
                });
                return cat || f;
            });
        const size = await dirSize(backupPath);
        backups.push({
            id: entry.name,
            path: backupPath,
            categories,
            size,
            timestamp: entry.name.replace(/T/g, ' ').replace(/Z/g, '').replace(/-/g, ':').replace(/:/g, '-', 2),
        });
    }

    backups.sort((a, b) => b.id.localeCompare(a.id));
    return backups;
}

async function restoreBackup(backupId, config, stDataRoot) {
    const backupDir = resolveBackupDir(backupId, stDataRoot);

    if (!(await fs.pathExists(backupDir))) {
        throw Object.assign(new Error(`备份 "${backupId}" 不存在。`), { statusCode: 404 });
    }

    const restored = [];
    for (const category of dataLayout.CATEGORIES) {
        if (!config.dataSelection[category]) continue;
        const targetPath = dataLayout.getSourcePath(category, stDataRoot);
        const baseName = path.basename(targetPath);
        const sourcePath = path.join(backupDir, baseName);

        if (!(await fs.pathExists(sourcePath))) continue;

        await fs.ensureDir(path.dirname(targetPath));
        await fs.copy(sourcePath, targetPath, { overwrite: true });
        restored.push(category);
    }

    return { restored, backupId };
}

async function deleteBackup(backupId, stDataRoot) {
    const backupDir = resolveBackupDir(backupId, stDataRoot);

    if (!(await fs.pathExists(backupDir))) {
        throw Object.assign(new Error(`备份 "${backupId}" 不存在。`), { statusCode: 404 });
    }

    await fs.remove(backupDir);
}

/**
 * 按「数量」和「总体积」双重上限裁剪旧备份。
 *
 * 只按数量裁剪是不够的：单次备份实测可达 359 MB，保留 5 份就是约 1.8 GB。
 * 因此在数量裁剪之后再按总体积从最旧的开始删，直到低于上限。
 * 无论如何至少保留 1 份 —— 否则当上限小于单份体积时会把备份删空。
 *
 * @param {string} backupRoot
 * @param {number} maxBackups
 * @param {number} maxTotalSizeMB
 * @returns {Promise<{removed: string[], totalSize: number}>}
 */
async function cleanupOldBackups(backupRoot, maxBackups, maxTotalSizeMB) {
    if (!(await fs.pathExists(backupRoot))) return { removed: [], totalSize: 0 };

    const entries = await fs.readdir(backupRoot, { withFileTypes: true });
    const dirs = entries
        .filter(e => e.isDirectory() && BACKUP_ID_PATTERN.test(e.name))
        .map(e => e.name)
        .sort((a, b) => b.localeCompare(a)); // 新 -> 旧

    const removed = [];

    // 第一道闸门：数量
    while (dirs.length > maxBackups) {
        const oldest = dirs.pop();
        await fs.remove(path.join(backupRoot, oldest));
        removed.push(oldest);
    }

    // 第二道闸门：总体积
    const capBytes = (Number.isFinite(maxTotalSizeMB) && maxTotalSizeMB > 0)
        ? maxTotalSizeMB * 1024 * 1024
        : Infinity;

    const sizes = [];
    for (const name of dirs) sizes.push(await dirSize(path.join(backupRoot, name)));
    let totalSize = sizes.reduce((a, b) => a + b, 0);

    while (capBytes !== Infinity && dirs.length > 1 && totalSize > capBytes) {
        const oldest = dirs.pop();
        const size = sizes.pop();
        await fs.remove(path.join(backupRoot, oldest));
        removed.push(oldest);
        totalSize -= size;
    }

    return { removed, totalSize };
}

async function dirSize(dirPath) {
    if (!(await fs.pathExists(dirPath))) return 0;
    let size = 0;
    const entries = await fs.readdir(dirPath, { withFileTypes: true });
    for (const entry of entries) {
        const fp = path.join(dirPath, entry.name);
        if (entry.isDirectory()) {
            size += await dirSize(fp);
        } else {
            size += (await fs.stat(fp)).size;
        }
    }
    return size;
}

function formatSize(bytes) {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}

module.exports = {
    createBackup,
    listBackups,
    restoreBackup,
    deleteBackup,
    cleanupOldBackups,
    formatSize,
    resolveBackupDir,
    computeFingerprint,
    DEFAULT_MAX_TOTAL_SIZE_MB,
    META_FILE_NAME,
};
