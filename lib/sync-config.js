const DEFAULT_CONFIG = {
    githubRepo: '',
    githubToken: '',
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
    },
    autoPush: {
        enabled: false,
        intervalMinutes: 30,
    },
    pullConfirmation: true,
};

function validateConfig(cfg) {
    const errors = [];

    if (!cfg.githubRepo || typeof cfg.githubRepo !== 'string' || !/^[\w.-]+\/[\w.-]+$/.test(cfg.githubRepo)) {
        errors.push('Repository must be in the format "username/repo-name".');
    }

    if (!cfg.githubToken || typeof cfg.githubToken !== 'string' || cfg.githubToken.trim().length === 0) {
        errors.push('GitHub personal access token is required.');
    }

    if (!cfg.branch || typeof cfg.branch !== 'string' || cfg.branch.trim().length === 0) {
        errors.push('Branch name is required.');
    }

    if (cfg.autoPush && cfg.autoPush.enabled) {
        const interval = cfg.autoPush.intervalMinutes;
        if (typeof interval !== 'number' || interval < 5) {
            errors.push('Auto-push interval must be at least 5 minutes.');
        }
    }

    if (cfg.dataSelection && typeof cfg.dataSelection === 'object') {
        const anySelected = Object.values(cfg.dataSelection).some(v => v === true);
        if (!anySelected) {
            errors.push('At least one data category must be selected for sync.');
        }
    } else {
        errors.push('dataSelection must be an object with at least one category enabled.');
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
    if (typeof partial.githubToken === 'string') merged.githubToken = partial.githubToken;
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

    if (typeof partial.pullConfirmation === 'boolean') merged.pullConfirmation = partial.pullConfirmation;

    return merged;
}

function maskConfig(config) {
    const masked = JSON.parse(JSON.stringify(config));
    if (masked.githubToken) {
        masked.githubToken = '*'.repeat(Math.min(masked.githubToken.length, 40));
    }
    return masked;
}

module.exports = {
    DEFAULT_CONFIG,
    validateConfig,
    mergeWithDefaults,
    maskConfig,
};