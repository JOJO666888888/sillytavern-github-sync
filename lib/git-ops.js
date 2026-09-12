const simpleGit = require('simple-git');
const path = require('path');
const fs = require('fs-extra');
const { resolveGithubToken } = require('./sync-config');
const secrets = require('./secrets');

// Prevent git from prompting for password (blocks the process)
const GIT_ENV_BASE = { GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' };

// git 操作超时（毫秒）。
// git 自身没有超时机制；GIT_TERMINAL_PROMPT=0 只阻止交互式密码提示，
// 并不能阻止 TCP 连接卡死。没有这个兜底，网络异常时同步会永久挂起。
const GIT_TIMEOUT_MS = 180000;

// 网络类 git 操作的重试次数与基准退避时间
const GIT_RETRY_ATTEMPTS = 3;
const GIT_RETRY_BASE_DELAY_MS = 800;

/**
 * 构造 git 子进程的环境变量。
 *
 * 凭据通过 GIT_ASKPASS 机制提供（助手脚本见 lib/secrets.js）：
 * - 不出现在命令行参数里（`ps` 可见）；
 * - 不写入 .git/config（此前 token 被拼进 remote URL 后由 set-url 持久化到磁盘）；
 * - 不依赖 GIT_CONFIG_COUNT 环境注入 —— 该机制 git 2.31 才引入、2.55 又默认禁用
 *   （实测报 "not permitted without enabling allowUnsafeConfigEnvCount"），
 *   而 GIT_ASKPASS 在所有 git 版本上都可用。
 *
 * @param {Object} [config] 合并后的同步配置；为空则不带凭据（用于纯本地操作）
 */
// simple-git 3.27+ 会对传给 .env() 的环境变量做安全校验，下列键名（小写）会被直接拒绝，
// 必须启用对应的 allowUnsafe* 开关才放行。我们的凭据只走 GIT_ASKPASS（已显式放行），
// 其余同名变量一律不通传 —— 否则宿主环境里的变量（例如 Termux 标配的 PREFIX）会让
// 所有 git 操作被 simple-git 拦下。
const SIMPLE_GIT_BLOCKED_ENV = new Set([
    'editor', 'pager', 'prefix', 'ssh_askpass',
    'git_askpass', 'git_config', 'git_config_count', 'git_config_global', 'git_config_system',
    'git_editor', 'git_exec_path', 'git_external_diff', 'git_pager', 'git_proxy_command',
    'git_sequence_editor', 'git_ssh', 'git_ssh_command', 'git_template_dir',
]);

function buildGitEnv(config) {
    // 重要：simple-git 的 .env() 是「替换」而非「合并」子进程环境
    // （实测：父进程 export 的变量在 askpass 子进程里不可见），因此必须完整继承
    // process.env，否则 git 会丢掉 PATH 而无法运行。
    // 同时必须剔除 SIMPLE_GIT_BLOCKED_ENV —— 否则 Termux 的 PREFIX 等变量
    // 会触发 simple-git 的安全校验，导致所有 git 操作直接抛错。
    const env = {};
    for (const [key, value] of Object.entries(process.env)) {
        if (value === undefined) continue;
        if (SIMPLE_GIT_BLOCKED_ENV.has(key.toLowerCase())) continue;
        env[key] = value;
    }
    Object.assign(env, GIT_ENV_BASE);

    const token = config ? resolveGithubToken(config) : '';
    if (token) {
        try {
            env.GIT_ASKPASS = secrets.ensureAskpassSync();
        } catch { /* 创建失败时降级为无凭据：git 会快速报鉴权错误，而不是挂起 */ }
        if (config && typeof config.tokenFile === 'string' && config.tokenFile.trim()) {
            env.ST_GITHUB_SYNC_TOKEN_FILE = config.tokenFile.trim();
        }
    }
    return env;
}

/**
 * 创建 simple-git 实例。
 *
 * simple-git 3.27+ 默认拦截 GIT_ASKPASS（映射到 allowUnsafeAskPass）并直接抛错，
 * 因此必须显式放行。这是可接受的：凭据来自用户自己的配置，且 askpass 助手
 * 只读取本地 0600 密钥文件，不接受任何外部输入。
 *
 * @param {string} [repoDir] 仓库目录；省略则使用当前工作目录
 * @param {Object} [config] 合并后的同步配置
 */
function gitWithEnv(repoDir, config) {
    const opts = {
        unsafe: { allowUnsafeAskPass: true },
        // git 自身没有超时；网络卡死时必须靠 simple-git 的 block 超时兜底，
        // 否则同步操作会永久挂起，用户只能强杀进程。
        timeout: { block: GIT_TIMEOUT_MS },
    };
    const git = repoDir ? simpleGit(repoDir, opts) : simpleGit(opts);
    return git.env(buildGitEnv(config));
}

/**
 * remote URL 一律不带凭据。
 * 凭据走 buildGitEnv 注入；即使仓库历史里残留带凭据的 URL，
 * 每次 pull/push 的 set-url 也会把它覆盖成干净的地址。
 */
function buildRemoteUrl(config) {
    const { githubRepo } = config;
    return `https://github.com/${githubRepo}.git`;
}

function redactToken(str) {
    if (typeof str !== 'string') return str;
    return str.replace(/(https:\/\/)[^@]+(@)/g, '$1***$2');
}

/**
 * 判断 git 错误是否属于「可重试的瞬时故障」。
 *
 * 关键点：绝不能重试鉴权/权限类错误 —— 那类错误重试多少次结果都一样，
 * 只会把一次失败变成三次失败，还让用户白等好几秒。
 */
function isTransientGitError(err) {
    const msg = String(err?.message || err || '').toLowerCase();

    // 明确不可重试：凭据、权限、仓库不存在、被安全策略拦截
    if (/authentication failed|invalid username or token|invalid credentials|permission denied|repository not found|could not read username|could not read password|not permitted|does not exist|not a git repository/.test(msg)) {
        return false;
    }

    return /timed?\s*out|etimedout|econnreset|econnrefused|enotfound|eai_again|ehostunreach|network is unreachable|could not resolve host|connection reset|connection timed out|remote end hung up|early eof|rpc failed|tls|ssl|502|503|504|temporary failure|try again/.test(msg);
}

/**
 * 带指数退避的重试包装。只对瞬时网络错误重试，其余错误立即抛出。
 *
 * @param {() => Promise<any>} fn
 * @param {string} label 用于日志的操作名
 */
async function withGitRetry(fn, label) {
    let lastErr;

    for (let attempt = 0; attempt < GIT_RETRY_ATTEMPTS; attempt++) {
        try {
            return await fn();
        } catch (err) {
            lastErr = err;

            const isLastAttempt = attempt === GIT_RETRY_ATTEMPTS - 1;
            if (isLastAttempt || !isTransientGitError(err)) throw err;

            const delay = GIT_RETRY_BASE_DELAY_MS * Math.pow(2, attempt);
            console.warn(`[github-data-sync] ${label}失败，${delay}ms 后重试（第 ${attempt + 1} 次重试）: ${redactToken(err.message)}`);
            await new Promise(resolve => setTimeout(resolve, delay));
        }
    }

    throw lastErr;
}

async function cloneRepo(config, targetDir) {
    await fs.ensureDir(path.dirname(targetDir));

    const remoteUrl = buildRemoteUrl(config);

    await withGitRetry(async () => {
        // 上一次失败的克隆可能留下半个目录，会让重试时 git 直接拒绝写入
        if (await fs.pathExists(targetDir)) {
            const hasGit = await fs.pathExists(path.join(targetDir, '.git'));
            const entries = await fs.readdir(targetDir).catch(() => []);
            if (!hasGit && entries.length > 0) {
                await fs.remove(targetDir);
            }
        }

        const git = gitWithEnv(undefined, config);
        try {
            await git.clone(remoteUrl, targetDir, [
                '--single-branch',
                '--branch', config.branch,
            ]);
        } catch {
            // 空仓库没有任何分支 —— 不带 --branch 克隆后再重命名
            await git.clone(remoteUrl, targetDir);
            const repoSg = gitWithEnv(targetDir, config);
            await repoSg.branch(['-M', config.branch]);
        }
    }, '克隆仓库');

    const repoSg = gitWithEnv(targetDir, config);
    const author = config.commitAuthor || { name: 'SillyTavern Sync', email: 'st-sync@localhost' };
    await repoSg.addConfig('user.name', author.name);
    await repoSg.addConfig('user.email', author.email);
    // 分支分叉时使用 merge 而非 rebase，避免 git 拒绝拉取
    await repoSg.addConfig('pull.rebase', 'false');
}

async function pullRepo(config, repoDir) {
    const git = gitWithEnv(repoDir, config);

    // 同步 remote URL（不带凭据；凭据走环境变量注入）
    const remoteUrl = buildRemoteUrl(config);
    await git.remote(['set-url', 'origin', remoteUrl]);

    // 注意：不再使用 -X ours —— 那会让所有冲突静默偏向本地、丢弃远端更新，
    // 且冲突解决界面永远无法触发。冲突应暴露给 UI 由用户逐文件决定。
    const pullResult = await withGitRetry(
        () => git.pull('origin', config.branch, ['--no-rebase']),
        '拉取'
    );
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
    const git = gitWithEnv(repoDir, config);

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

    const pushResult = await withGitRetry(
        () => git.push('origin', config.branch),
        '推送'
    );

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
    const git = gitWithEnv(repoDir);
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
        await gitWithEnv(repoDir).status();
        return true;
    } catch {
        return false;
    }
}

// ===================== Conflict resolution =====================

async function fetchRepo(config, repoDir) {
    const git = gitWithEnv(repoDir, config);
    const remoteUrl = buildRemoteUrl(config);
    await git.remote(['set-url', 'origin', remoteUrl]);
    await withGitRetry(() => git.fetch('origin', config.branch), '抓取远程');
}

async function resetToRemote(config, repoDir) {
    const git = gitWithEnv(repoDir);
    await git.reset(['--hard', `origin/${config.branch}`]);
}

async function getConflictFiles(repoDir) {
    const git = gitWithEnv(repoDir);
    const status = await git.status();
    return status.conflicted || [];
}

async function checkoutOurs(repoDir, file) {
    const git = gitWithEnv(repoDir);
    await git.checkout(['--ours', file]);
    await git.add(file);
}

async function checkoutTheirs(repoDir, file) {
    const git = gitWithEnv(repoDir);
    await git.checkout(['--theirs', file]);
    await git.add(file);
}

async function resolveAllOurs(repoDir) {
    const git = gitWithEnv(repoDir);
    await git.checkout(['--ours', '.']);
    await git.add('.');
}

async function resolveAllTheirs(repoDir) {
    const git = gitWithEnv(repoDir);
    await git.checkout(['--theirs', '.']);
    await git.add('.');
}

async function commitResolved(repoDir, message) {
    const git = gitWithEnv(repoDir);
    await git.commit(message);
}

async function forcePush(config, repoDir) {
    const git = gitWithEnv(repoDir, config);
    const remoteUrl = buildRemoteUrl(config);
    await git.remote(['set-url', 'origin', remoteUrl]);
    await withGitRetry(() => git.push('origin', config.branch, ['--force']), '强制推送');
}

async function autoCommitLocal(repoDir) {
    const git = gitWithEnv(repoDir);
    await git.add('.');
    const status = await git.status();
    if (status.files && status.files.length > 0) {
        await git.commit('Auto sync local changes');
        return true;
    }
    return false;
}

async function addFile(repoDir, file) {
    const git = gitWithEnv(repoDir);
    await git.add(file);
}

/**
 * 中止未完成的 merge，把仓库恢复到 merge 之前的状态。
 * 用于推送前预拉取遇到冲突时清理现场 —— 否则仓库停留在冲突状态，
 * 后续 pushData 会把冲突标记当作正常内容提交上去。
 */
async function abortMerge(repoDir) {
    const git = gitWithEnv(repoDir);
    await git.raw(['merge', '--abort']);
}

module.exports = {
    buildRemoteUrl,
    buildGitEnv,
    gitWithEnv,
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
    addFile,
    abortMerge,
    withGitRetry,
    isTransientGitError,
    GIT_TIMEOUT_MS,
};