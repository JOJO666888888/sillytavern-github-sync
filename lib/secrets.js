const path = require('path');
const os = require('os');
const fs = require('fs-extra');

/**
 * GitHub Token 的独立存储。
 *
 * 不放在 data/<user>/ 里的原因：那棵目录树会被 SillyTavern 自身的备份、
 * 本插件的同步与备份、以及用户的数据快照一并带走，明文 token 会随之扩散。
 * 这里放在用户主目录下的独立目录，权限收紧到 0700/0600，且不参与任何同步。
 *
 * 注意：这仍然是一个明文文件，只是位置和权限都比放在数据目录里安全得多。
 * 若部署环境支持，优先使用 ST_GITHUB_SYNC_TOKEN 环境变量。
 */

const SECRETS_DIR = path.join(os.homedir(), '.sillytavern-github-sync');

/** 把用户 handle 转成安全的文件名。 */
function safeHandle(handle) {
    return String(handle || 'default-user').replace(/[^a-zA-Z0-9._-]/g, '_');
}

/** 该用户 token 文件的默认绝对路径。 */
function getTokenFilePath(handle) {
    return path.join(SECRETS_DIR, `${safeHandle(handle)}.token`);
}

/** 从指定文件读取 token；不存在或失败返回空字符串。 */
function readTokenFromFile(filePath) {
    try {
        if (!filePath || !fs.existsSync(filePath)) return '';
        return String(fs.readFileSync(filePath, 'utf8')).trim();
    } catch {
        return '';
    }
}

/**
 * 把 token 写入指定文件，权限 0600（目录 0700）。
 * @returns {string} 写入的文件路径
 */
function writeTokenToFile(filePath, token) {
    const value = String(token || '').trim();
    if (!value) throw new Error('token 为空，拒绝写入。');

    const dir = path.dirname(filePath);
    fs.ensureDirSync(dir, { mode: 0o700 });
    try { fs.chmodSync(dir, 0o700); } catch { /* 部分文件系统不支持 chmod */ }

    fs.writeFileSync(filePath, value, { mode: 0o600 });
    try { fs.chmodSync(filePath, 0o600); } catch { /* 同上 */ }

    return filePath;
}

/** 删除 token 文件。 */
function removeTokenFromFile(filePath) {
    try {
        if (filePath && fs.existsSync(filePath)) fs.removeSync(filePath);
    } catch { /* ignore */ }
}

const ASKPASS_NAME = 'askpass.sh';

/** askpass 助手的固定路径（助手本身不含机密，所有用户共用一份）。 */
function getAskpassPath() {
    return path.join(SECRETS_DIR, ASKPASS_NAME);
}

/**
 * 确保 GIT_ASKPASS 助手脚本存在且可执行（幂等）。
 *
 * git 在需要凭据时调用该脚本：用户名固定为 x-access-token（GitHub PAT 的惯例），
 * 密码优先从 ST_GITHUB_SYNC_TOKEN_FILE 指定的密钥文件读取，其次回退到
 * ST_GITHUB_SYNC_TOKEN 环境变量。这样 token 既不出现在命令行参数（ps 可见），
 * 也不写入 .git/config。
 *
 * @returns {string} 脚本路径
 */
function ensureAskpassSync() {
    const file = getAskpassPath();
    if (!fs.existsSync(file)) {
        fs.ensureDirSync(SECRETS_DIR, { mode: 0o700 });
        const content = [
            '#!/bin/sh',
            '# 由 SillyTavern 的 github-data-sync 插件自动生成，请勿手改。',
            '# git 通过 GIT_ASKPASS 调用本脚本获取 GitHub 凭据：',
            '#   用户名固定为 x-access-token；',
            '#   密码优先读 ST_GITHUB_SYNC_TOKEN_FILE 密钥文件，其次回退 ST_GITHUB_SYNC_TOKEN 环境变量。',
            'case "$1" in',
            '    *[Uu]sername*)',
            '        echo "x-access-token"',
            '        ;;',
            '    *[Pp]assword*)',
            '        cat "$ST_GITHUB_SYNC_TOKEN_FILE" 2>/dev/null || printf "%s" "$ST_GITHUB_SYNC_TOKEN"',
            '        ;;',
            '    *)',
            '        exit 1',
            '        ;;',
            'esac',
            '',
        ].join('\n');
        fs.writeFileSync(file, content, { mode: 0o700 });
        try { fs.chmodSync(file, 0o700); } catch { /* 部分文件系统不支持 */ }
    }
    return file;
}

module.exports = {
    SECRETS_DIR,
    getTokenFilePath,
    readTokenFromFile,
    writeTokenToFile,
    removeTokenFromFile,
    getAskpassPath,
    ensureAskpassSync,
};
