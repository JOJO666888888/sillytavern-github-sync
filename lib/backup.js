const path = require('path');
const fs = require('fs-extra');
const dataLayout = require('./data-layout');

const BACKUP_DIR_NAME = 'backups/github-sync';

function getBackupRoot(stDataRoot) {
    return path.join(stDataRoot, '..', BACKUP_DIR_NAME);
}

async function createBackup(config, stDataRoot) {
    if (!config.autoBackup?.enabled) return null;

    const backupRoot = getBackupRoot(stDataRoot);
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
        return null;
    }

    // Cleanup old backups
    const maxBackups = config.autoBackup?.maxBackups || 5;
    await cleanupOldBackups(backupRoot, maxBackups);

    return {
        id: timestamp,
        path: backupDir,
        categories: backedUp,
        size: totalSize,
        timestamp: new Date().toISOString(),
    };
}

async function listBackups(stDataRoot) {
    const backupRoot = getBackupRoot(stDataRoot);
    if (!(await fs.pathExists(backupRoot))) return [];

    const entries = await fs.readdir(backupRoot, { withFileTypes: true });
    const backups = [];

    for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const backupPath = path.join(backupRoot, entry.name);
        const files = await fs.readdir(backupPath);
        const categories = files.map(f => {
            // Map file/dir name back to category
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
    const backupRoot = getBackupRoot(stDataRoot);
    const backupDir = path.join(backupRoot, backupId);

    if (!(await fs.pathExists(backupDir))) {
        throw new Error(`Backup "${backupId}" not found.`);
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
    const backupRoot = getBackupRoot(stDataRoot);
    const backupDir = path.join(backupRoot, backupId);

    if (!(await fs.pathExists(backupDir))) {
        throw new Error(`Backup "${backupId}" not found.`);
    }

    await fs.remove(backupDir);
}

async function cleanupOldBackups(backupRoot, maxBackups) {
    if (!(await fs.pathExists(backupRoot))) return;

    const entries = await fs.readdir(backupRoot, { withFileTypes: true });
    const dirs = entries.filter(e => e.isDirectory()).sort((a, b) => b.name.localeCompare(a.name));

    while (dirs.length > maxBackups) {
        const oldest = dirs.pop();
        await fs.remove(path.join(backupRoot, oldest.name));
    }
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
};