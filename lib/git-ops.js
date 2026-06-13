const simpleGit = require('simple-git');
const path = require('path');
const fs = require('fs-extra');

function buildRemoteUrl(config) {
    const { githubToken, githubRepo } = config;
    return `https://${githubToken}@github.com/${githubRepo}.git`;
}

function redactToken(str) {
    if (typeof str !== 'string') return str;
    return str.replace(/(https:\/\/)[^@]+(@)/g, '$1***$2');
}

async function cloneRepo(config, targetDir) {
    await fs.ensureDir(path.dirname(targetDir));

    const remoteUrl = buildRemoteUrl(config);
    const git = simpleGit();
    try {
        await git.clone(remoteUrl, targetDir, [
            '--single-branch',
            '--branch', config.branch,
        ]);
    } catch {
        // Empty repo has no branches — clone without --branch, then rename
        await git.clone(remoteUrl, targetDir);
        const repoSg = simpleGit(targetDir);
        await repoSg.branch(['-M', config.branch]);
    }

    const repoSg = simpleGit(targetDir);
    const author = config.commitAuthor || { name: 'SillyTavern Sync', email: 'st-sync@localhost' };
    await repoSg.addConfig('user.name', author.name);
    await repoSg.addConfig('user.email', author.email);
}

async function pullRepo(config, repoDir) {
    const git = simpleGit(repoDir);

    // Update remote URL in case token changed
    const remoteUrl = buildRemoteUrl(config);
    await git.remote(['set-url', 'origin', remoteUrl]);

    const pullResult = await git.pull('origin', config.branch);
    return {
        hash: pullResult.commit || '',
        summary: {
            changes: pullResult.summary?.changes || 0,
            insertions: pullResult.summary?.insertions || 0,
            deletions: pullResult.summary?.deletions || 0,
        },
    };
}

async function pushRepo(config, repoDir, commitMessage) {
    const git = simpleGit(repoDir);

    // Update remote URL in case token changed
    const remoteUrl = buildRemoteUrl(config);
    await git.remote(['set-url', 'origin', remoteUrl]);

    // Stage all changes
    await git.add('./*');

    // Check if there's anything to commit
    const status = await git.status();
    if (!status.files || status.files.length === 0) {
        return { skipped: true, commitHash: '', pushed: false };
    }

    await git.commit(commitMessage);

    const pushResult = await git.push('origin', config.branch);

    // Get the latest commit hash
    const log = await git.log({ maxCount: 1 });
    const commitHash = log.latest?.hash || '';

    return {
        skipped: false,
        commitHash,
        pushed: pushResult.pushed || [],
    };
}

async function getStatus(repoDir) {
    const git = simpleGit(repoDir);
    const status = await git.status();
    return {
        modified: status.modified || [],
        added: status.not_added || [],
        deleted: status.deleted || [],
        created: status.created || [],
        staged: status.staged || [],
        ahead: status.ahead || 0,
        behind: status.behind || 0,
        current: status.current || '',
        hasChanges: (status.files || []).length > 0,
    };
}

async function isRepo(repoDir) {
    try {
        const dotGit = path.join(repoDir, '.git');
        if (!(await fs.pathExists(dotGit))) return false;
        await simpleGit(repoDir).status();
        return true;
    } catch {
        return false;
    }
}

// ===================== Conflict resolution =====================

async function fetchRepo(config, repoDir) {
    const git = simpleGit(repoDir);
    const remoteUrl = buildRemoteUrl(config);
    await git.remote(['set-url', 'origin', remoteUrl]);
    await git.fetch('origin', config.branch);
}

async function resetToRemote(config, repoDir) {
    const git = simpleGit(repoDir);
    await git.reset(['--hard', `origin/${config.branch}`]);
}

async function getConflictFiles(repoDir) {
    const git = simpleGit(repoDir);
    const status = await git.status();
    return status.conflicted || [];
}

async function checkoutOurs(repoDir, file) {
    const git = simpleGit(repoDir);
    await git.checkout(['--ours', file]);
    await git.add(file);
}

async function checkoutTheirs(repoDir, file) {
    const git = simpleGit(repoDir);
    await git.checkout(['--theirs', file]);
    await git.add(file);
}

async function resolveAllOurs(repoDir) {
    const git = simpleGit(repoDir);
    await git.checkout(['--ours', '.']);
    await git.add('.');
}

async function resolveAllTheirs(repoDir) {
    const git = simpleGit(repoDir);
    await git.checkout(['--theirs', '.']);
    await git.add('.');
}

async function commitResolved(repoDir, message) {
    const git = simpleGit(repoDir);
    await git.commit(message);
}

async function forcePush(config, repoDir) {
    const git = simpleGit(repoDir);
    const remoteUrl = buildRemoteUrl(config);
    await git.remote(['set-url', 'origin', remoteUrl]);
    await git.push('origin', config.branch, ['--force']);
}

async function autoCommitLocal(repoDir) {
    const git = simpleGit(repoDir);
    await git.add('.');
    const status = await git.status();
    if (status.files && status.files.length > 0) {
        await git.commit('Auto sync local changes');
        return true;
    }
    return false;
}

module.exports = {
    buildRemoteUrl,
    redactToken,
    cloneRepo,
    pullRepo,
    pushRepo,
    getStatus,
    isRepo,
    fetchRepo,
    resetToRemote,
    getConflictFiles,
    checkoutOurs,
    checkoutTheirs,
    resolveAllOurs,
    resolveAllTheirs,
    commitResolved,
    forcePush,
    autoCommitLocal,
};