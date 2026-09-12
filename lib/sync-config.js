const secrets = require('./secrets');

const DEFAULT_CONFIG = {
    githubRepo: '',
    githubToken: '',
    // Token 的独立存储路径（0600 密钥文件，位于数据目录之外）。
    // 为空时仅从环境变量 / 本字段读取。
    tokenFile: '',
    branch: 'main',
    commitAuthor: {
        name: 'SillyTavern Sync',
        email: 'st-sync@localhost',
    },
    dataSelection: {
        characters: true,
        chats: true,
        worlds: true,
        groups: true,
        settings: true,
        presets: true,
        backgrounds: false,
        themes: false,
        personas: true,
        extensions: true,
    },
    autoPush: {
        enabled: false,
        intervalMinutes: 30,
    },
    autoBackup: {
        enabled: true,
        maxBackups: 5,
    },
    pullConfirmation: true,
    pullMode: 'local-first', // 'local-first' (合并模式) or 'remote-first' (覆盖模式)
};

/**
 * 解析 GitHub token，按优先级：
 * 1) 环境变量 ST_GITHUB_SYNC_TOKEN（或 GITHUB_TOKEN）—— 部署层注入，优先级最高；
 * 2) 独立密钥文件（cfg.tokenFile，0600，位于数据目录之外）—— 推荐持久化方式；
 * 3) 旧版明文配置字段（cfg.githubToken）—— 仅作迁移来源，迁移后会被清空。
 * @param {Object} cfg 合并后的配置
 * @returns {string} 可用的 token（可能为空字符串）
 */
function resolveGithubToken(cfg) {
    const fromEnv = (process.env.ST_GITHUB_SYNC_TOKEN || process.env.GITHUB_TOKEN || '').trim();
    if (fromEnv) return fromEnv;

    if (cfg && typeof cfg.tokenFile === 'string' && cfg.tokenFile.trim()) {
        const fromFile = secrets.readTokenFromFile(cfg.tokenFile.trim());
        if (fromFile) return fromFile;
    }

    if (cfg && typeof cfg.githubToken === 'string') return cfg.githubToken.trim();
    return '';
}

function validateConfig(cfg) {
    const errors = [];

    if (!cfg.githubRepo || typeof cfg.githubRepo !== 'string' || !/^[\w.-]+\/[\w.-]+$/.test(cfg.githubRepo)) {
        errors.push('仓库名格式必须为 "用户名/仓库名"。');
    }

    if (!resolveGithubToken(cfg)) {
        errors.push('GitHub 个人访问令牌是必填项（请设置环境变量 ST_GITHUB_SYNC_TOKEN）。');
    }

    if (!cfg.branch || typeof cfg.branch !== 'string' || cfg.branch.trim().length === 0) {
        errors.push('分支名是必填项。');
    }

    if (cfg.autoPush && cfg.autoPush.enabled) {
        const interval = cfg.autoPush.intervalMinutes;
        if (typeof interval !== 'number' || interval < 5) {
            errors.push('自动推送间隔必须至少 5 分钟。');
        }
    }

    if (cfg.dataSelection && typeof cfg.dataSelection === 'object') {
        const anySelected = Object.values(cfg.dataSelection).some(v => v === true);
        if (!anySelected) {
            errors.push('至少需要选择一个数据类别进行同步。');
        }
    } else {
        errors.push('dataSelection 必须是一个至少启用一个类别的对象。');
    }

    return {
        valid: errors.length === 0,
        errors,
    };
}

function mergeWithDefaults(partial) {
    if (!partial || typeof partial !== 'object') {
        return JSON.parse(JSON.stringify(DEFAULT_CONFIG));
    }

    const merged = JSON.parse(JSON.stringify(DEFAULT_CONFIG));

    if (typeof partial.githubRepo === 'string') merged.githubRepo = partial.githubRepo;
    if (typeof partial.githubToken === 'string' && partial.githubToken.trim().length > 0) merged.githubToken = partial.githubToken;
    if (typeof partial.tokenFile === 'string') merged.tokenFile = partial.tokenFile;
    if (typeof partial.branch === 'string') merged.branch = partial.branch;

    if (partial.commitAuthor && typeof partial.commitAuthor === 'object') {
        if (typeof partial.commitAuthor.name === 'string') merged.commitAuthor.name = partial.commitAuthor.name;
        if (typeof partial.commitAuthor.email === 'string') merged.commitAuthor.email = partial.commitAuthor.email;
    }

    if (partial.dataSelection && typeof partial.dataSelection === 'object') {
        for (const key of Object.keys(merged.dataSelection)) {
            if (typeof partial.dataSelection[key] === 'boolean') {
                merged.dataSelection[key] = partial.dataSelection[key];
            }
        }
    }

    if (partial.autoPush && typeof partial.autoPush === 'object') {
        if (typeof partial.autoPush.enabled === 'boolean') merged.autoPush.enabled = partial.autoPush.enabled;
        if (typeof partial.autoPush.intervalMinutes === 'number') merged.autoPush.intervalMinutes = partial.autoPush.intervalMinutes;
    }

    if (partial.autoBackup && typeof partial.autoBackup === 'object') {
        if (typeof partial.autoBackup.enabled === 'boolean') merged.autoBackup.enabled = partial.autoBackup.enabled;
        if (typeof partial.autoBackup.maxBackups === 'number') merged.autoBackup.maxBackups = partial.autoBackup.maxBackups;
    }

    if (typeof partial.pullConfirmation === 'boolean') merged.pullConfirmation = partial.pullConfirmation;
    if (partial.pullMode === 'local-first' || partial.pullMode === 'remote-first') merged.pullMode = partial.pullMode;

    return merged;
}

function maskConfig(config) {
    const masked = JSON.parse(JSON.stringify(config));
    const token = resolveGithubToken(config);
    if (token) {
        masked.githubToken = '*'.repeat(Math.min(token.length, 40));
    }
    return masked;
}

module.exports = {
    DEFAULT_CONFIG,
    validateConfig,
    mergeWithDefaults,
    maskConfig,
    resolveGithubToken,
};
