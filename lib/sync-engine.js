const path = require('path');
const fs = require('fs-extra');
const gitOps = require('./git-ops');
const dataLayout = require('./data-layout');

async function pushData(config, repoDir, stDataRoot) {
    const changedFiles = [];
    const skippedFiles = [];

    for (const category of dataLayout.CATEGORIES) {
        if (!config.dataSelection[category]) continue;

        const sourcePath = dataLayout.getSourcePath(category, stDataRoot);
        const targetPath = dataLayout.getTargetPath(category, repoDir);
        const type = dataLayout.getType(category);

        if (!(await fs.pathExists(sourcePath))) {
            skippedFiles.push(category);
            continue;
        }

        const hasChanged = await copyIfChanged(sourcePath, targetPath, type);
        if (hasChanged) {
            changedFiles.push(category);
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

async function pullData(config, repoDir, stDataRoot) {
    // Pull latest from remote first
    const pullResult = await gitOps.pullRepo(config, repoDir);

    const restoredFiles = [];
    const conflicts = [];

    for (const category of dataLayout.CATEGORIES) {
        if (!config.dataSelection[category]) continue;

        const sourcePath = dataLayout.getTargetPath(category, repoDir); // in repo
        const targetPath = dataLayout.getSourcePath(category, stDataRoot); // in ST data
        const type = dataLayout.getType(category);

        if (!(await fs.pathExists(sourcePath))) {
            continue;
        }

        // Check for conflict markers before copying
        const hasConflict = await detectConflictsInPath(sourcePath, type);
        if (hasConflict) {
            conflicts.push(category);
            continue;
        }

        await fs.ensureDir(path.dirname(targetPath));

        if (type === 'directory') {
            await fs.copy(sourcePath, targetPath, { overwrite: true });
        } else {
            await fs.copy(sourcePath, targetPath, { overwrite: true });
        }

        restoredFiles.push(category);
    }

    return {
        filesRestored: restoredFiles,
        conflicts,
        pullSummary: pullResult.summary,
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

async function detectConflictsInPath(filePath, type) {
    if (type === 'file') {
        return detectConflictMarkers(filePath);
    }

    if (type === 'directory') {
        return detectConflictsInDir(filePath);
    }

    return false;
}

async function detectConflictMarkers(filePath) {
    try {
        const content = await fs.readFile(filePath, 'utf-8');
        return content.includes('<<<<<<<') || content.includes('>>>>>>>') || content.includes('=======');
    } catch {
        return false;
    }
}

async function detectConflictsInDir(dir) {
    if (!(await fs.pathExists(dir))) return false;

    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            const has = await detectConflictsInDir(fullPath);
            if (has) return true;
        } else if (entry.isFile()) {
            const has = await detectConflictMarkers(fullPath);
            if (has) return true;
        }
    }
    return false;
}

module.exports = {
    pushData,
    pullData,
};