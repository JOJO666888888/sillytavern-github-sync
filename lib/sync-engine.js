const path = require('path');
const fs = require('fs-extra');
const gitOps = require('./git-ops');
const dataLayout = require('./data-layout');

const PLUGIN_ID = 'github-data-sync';

const CATEGORY_NAMES = {
    characters: '角色卡', chats: '聊天', worlds: '世界书', groups: '群组',
    settings: '设置', presets: '预设', backgrounds: '背景', themes: '主题', personas: '人格',
};

function countSelectedCategories(config) {
    return dataLayout.CATEGORIES.filter(c => config.dataSelection[c]).length;
}

async function pushData(config, repoDir, stDataRoot, onProgress) {
    const changedFiles = [];
    const skippedFiles = [];
    const total = countSelectedCategories(config);
    let done = 0;

    for (const category of dataLayout.CATEGORIES) {
        if (!config.dataSelection[category]) continue;
        done++;
        const label = CATEGORY_NAMES[category] || category;
        if (onProgress) onProgress(done, total, label, 'push');

        const sourcePath = dataLayout.getSourcePath(category, stDataRoot);
        const targetPath = dataLayout.getTargetPath(category, repoDir);
        const type = dataLayout.getType(category);

        if (!(await fs.pathExists(sourcePath))) {
            skippedFiles.push(category);
            continue;
        }

        // Strip API config from settings.json before syncing
        let effectiveSourcePath = sourcePath;
        if (category === 'settings' && type === 'file') {
            effectiveSourcePath = await filterSettingsForPush(sourcePath, targetPath);
        }

        const hasChanged = await copyIfChanged(effectiveSourcePath, targetPath, type);
        if (hasChanged) {
            changedFiles.push(category);
        }

        // Clean up temp filtered file
        if (effectiveSourcePath !== sourcePath) {
            await fs.remove(effectiveSourcePath).catch(() => {});
        }
    }

    if (changedFiles.length === 0) {
        return { skipped: true, filesChanged: [] };
    }

    const now = new Date().toISOString().replace('T', ' ').substring(0, 19);
    const summary = changedFiles.join(', ');
    const commitMessage = `sync: ${now} - ${summary}`;

    const pushResult = await gitOps.pushRepo(config, repoDir, commitMessage);

    return {
        ...pushResult,
        filesChanged: changedFiles,
        timestamp: new Date().toISOString(),
    };
}

async function pullData(config, repoDir, stDataRoot, onProgress) {
    const pullMode = config.pullMode || 'local-first';

    if (pullMode === 'remote-first') {
        return pullDataRemoteFirst(config, repoDir, stDataRoot, onProgress);
    }
    return pullDataLocalFirst(config, repoDir, stDataRoot, onProgress);
}

async function pullDataRemoteFirst(config, repoDir, stDataRoot, onProgress) {
    await gitOps.fetchRepo(config, repoDir);
    await gitOps.resetToRemote(config, repoDir);
    return copyFromRepo(config, repoDir, stDataRoot, onProgress, { changes: 0, insertions: 0, deletions: 0 });
}

async function pullDataLocalFirst(config, repoDir, stDataRoot, onProgress) {
    // Auto-commit local changes before pulling
    await gitOps.autoCommitLocal(repoDir);

    let pullResult;
    try {
        pullResult = await gitOps.pullRepo(config, repoDir);
    } catch (err) {
        // Pull failed — likely a merge conflict
        const msg = String(err.message || err);
        if (msg.includes('CONFLICT') || msg.includes('merge') || msg.includes('Automatic merge failed')) {
            const conflictFiles = await gitOps.getConflictFiles(repoDir);
            return {
                filesRestored: [],
                hasConflicts: true,
                conflictFiles,
                pullSummary: null,
                timestamp: new Date().toISOString(),
            };
        }
        throw err;
    }

    // Check if merge produced conflicts (pull succeeded but with conflicts)
    const conflictFiles = await gitOps.getConflictFiles(repoDir);
    if (conflictFiles.length > 0) {
        return {
            filesRestored: [],
            hasConflicts: true,
            conflictFiles,
            pullSummary: pullResult.summary,
            timestamp: new Date().toISOString(),
        };
    }

    return copyFromRepo(config, repoDir, stDataRoot, onProgress, pullResult.summary);
}

async function copyFromRepo(config, repoDir, stDataRoot, onProgress, pullSummary) {
    const restoredFiles = [];
    const total = countSelectedCategories(config);
    let done = 0;

    // Save local plugin config before overwriting settings.json
    let savedPluginConfig = null;
    const localSettingsPath = dataLayout.getSourcePath('settings', stDataRoot);
    if (config.dataSelection['settings'] && await fs.pathExists(localSettingsPath)) {
        try {
            const local = await fs.readJson(localSettingsPath);
            if (local?.extension_settings?.[PLUGIN_ID]) {
                savedPluginConfig = local.extension_settings[PLUGIN_ID];
            }
        } catch { /* ignore */ }
    }

    for (const category of dataLayout.CATEGORIES) {
        if (!config.dataSelection[category]) continue;
        done++;
        const label = CATEGORY_NAMES[category] || category;
        if (onProgress) onProgress(done, total, label, 'pull');

        const sourcePath = dataLayout.getTargetPath(category, repoDir);
        const targetPath = dataLayout.getSourcePath(category, stDataRoot);
        const type = dataLayout.getType(category);

        if (!(await fs.pathExists(sourcePath))) continue;

        await fs.ensureDir(path.dirname(targetPath));
        await fs.copy(sourcePath, targetPath, { overwrite: true });
        restoredFiles.push(category);
    }

    // Restore local plugin config into settings.json after pull
    if (savedPluginConfig && config.dataSelection['settings']) {
        try {
            const restored = await fs.readJson(localSettingsPath);
            if (!restored.extension_settings) restored.extension_settings = {};
            restored.extension_settings[PLUGIN_ID] = savedPluginConfig;
            await fs.writeJson(localSettingsPath, restored, { spaces: 4 });
        } catch { /* ignore */ }
    }

    return {
        filesRestored: restoredFiles,
        hasConflicts: false,
        conflictFiles: [],
        pullSummary,
        timestamp: new Date().toISOString(),
    };
}

async function copyIfChanged(sourcePath, targetPath, type) {
    await fs.ensureDir(path.dirname(targetPath));

    if (type === 'directory') {
        return copyDirIfChanged(sourcePath, targetPath);
    }

    return copyFileIfChanged(sourcePath, targetPath);
}

async function copyFileIfChanged(sourcePath, targetPath) {
    if (await fs.pathExists(targetPath)) {
        const srcStat = await fs.stat(sourcePath);
        const tgtStat = await fs.stat(targetPath);
        if (srcStat.size === tgtStat.size && srcStat.mtimeMs === tgtStat.mtimeMs) {
            return false;
        }
    }
    await fs.copy(sourcePath, targetPath, { overwrite: true });
    return true;
}

async function copyDirIfChanged(sourceDir, targetDir) {
    let changed = false;

    const entries = await fs.readdir(sourceDir, { withFileTypes: true });
    await fs.ensureDir(targetDir);

    for (const entry of entries) {
        const srcPath = path.join(sourceDir, entry.name);
        const tgtPath = path.join(targetDir, entry.name);

        if (entry.isDirectory()) {
            const subChanged = await copyDirIfChanged(srcPath, tgtPath);
            if (subChanged) changed = true;
        } else if (entry.isFile()) {
            const fileChanged = await copyFileIfChanged(srcPath, tgtPath);
            if (fileChanged) changed = true;
        }
    }

    // Also check for files in target that no longer exist in source
    if (await fs.pathExists(targetDir)) {
        const tgtEntries = await fs.readdir(targetDir, { withFileTypes: true });
        for (const entry of tgtEntries) {
            const srcPath = path.join(sourceDir, entry.name);
            const tgtPath = path.join(targetDir, entry.name);
            if (!(await fs.pathExists(srcPath))) {
                await fs.remove(tgtPath);
                changed = true;
            }
        }
    }

    return changed;
}

// Create a temp copy of settings.json with plugin config removed for push
async function filterSettingsForPush(sourcePath, targetPath) {
    try {
        const raw = await fs.readJson(sourcePath);
        if (raw?.extension_settings?.[PLUGIN_ID]) {
            const cleaned = JSON.parse(JSON.stringify(raw));
            delete cleaned.extension_settings[PLUGIN_ID];
            const tmpPath = targetPath + '.filtered-tmp';
            await fs.writeJson(tmpPath, cleaned, { spaces: 4 });
            return tmpPath;
        }
    } catch { /* if parse fails, fall through to use original */ }
    return sourcePath;
}

module.exports = {
    pushData,
    pullData,
};