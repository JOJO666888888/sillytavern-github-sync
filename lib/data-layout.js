const path = require('path');

const CATEGORIES = [
    'characters',
    'chats',
    'worlds',
    'groups',
    'settings',
    'presets',
    'backgrounds',
    'themes',
    'personas',
];

const LAYOUT_MAP = {
    characters:  { source: 'characters',    type: 'directory' },
    chats:       { source: 'chats',         type: 'directory' },
    worlds:      { source: 'worlds',        type: 'directory' },
    groups:      { source: 'groups',        type: 'directory' },
    settings:    { source: 'settings.json', type: 'file' },
    presets:     { source: 'OpenAI Settings', type: 'directory' },
    backgrounds: { source: 'backgrounds',    type: 'directory' },
    themes:      { source: 'themes',         type: 'directory' },
    personas:    { source: 'User Avatars',   type: 'directory' },
};

function getSourcePath(category, stDataRoot) {
    const entry = LAYOUT_MAP[category];
    if (!entry) return null;
    return path.join(stDataRoot, entry.source);
}

function getTargetPath(category, repoDir) {
    const entry = LAYOUT_MAP[category];
    if (!entry) return null;
    return path.join(repoDir, entry.source);
}

function getType(category) {
    const entry = LAYOUT_MAP[category];
    return entry ? entry.type : null;
}

module.exports = {
    CATEGORIES,
    LAYOUT_MAP,
    getSourcePath,
    getTargetPath,
    getType,
};