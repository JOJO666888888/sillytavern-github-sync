# GitHub Data Sync for SillyTavern

Sync SillyTavern data to a private GitHub repository — characters, chats, worlds, settings, and more. Push manually or on a timer. Pull to restore on any device.

## Features

- **Manual push/pull** via slash commands (`/sync-push`, `/sync-pull`, `/sync-status`)
- **Auto-push** on a configurable interval
- **Selectable data categories** — sync only what you need
- **Test connection** button to verify your repo and token
- **Sync log** with the last 10 operations
- **Token security** — PAT stored server-side, never exposed to the frontend

## Installation

### 1. Create a GitHub repository

Create a **private** repository on GitHub (e.g. `my-st-sync`).

### 2. Create a Personal Access Token

1. Go to [GitHub Settings > Developer settings > Personal access tokens > Fine-grained tokens](https://github.com/settings/tokens)
2. Click "Generate new token"
3. Select your private repository under "Repository access"
4. Under "Permissions", set **Contents** to **Read and write**
5. Generate and copy the token (`github_pat_...`)

### 3. Install the plugin

**Server plugin:**
```bash
cd /path/to/SillyTavern
cp -r github-data-sync plugins/github-data-sync
cd plugins/github-data-sync
npm install
```

**Frontend extension:**
```bash
cp plugins/github-data-sync/client/index.js public/scripts/extensions/third-party/github-data-sync.js
```

### 4. Restart SillyTavern

### 5. Configure

1. Open the Extensions panel (stack icon in the top bar)
2. Find "GitHub Data Sync" settings
3. Fill in your repository name (`username/repo`), branch, and token
4. Click **Test Connection** to verify
5. Select which data categories to sync
6. Optionally enable auto-push

## Usage

### Slash Commands

| Command | Action |
|---------|--------|
| `/sync-push` | Push local data to GitHub |
| `/sync-pull` | Pull latest data from GitHub and restore locally |
| `/sync-status` | Show current sync status and recent log entries |

### Auto-Push

Enable in settings to automatically push at a regular interval (minimum 5 minutes). The plugin will silently push changes in the background.

### Pull with Confirmation

By default, `/sync-pull` shows a confirmation dialog before overwriting local data. You can disable this in settings.

## Data Categories

| Category | Path |
|----------|------|
| Characters | `data/default-user/characters/` |
| Chats | `data/default-user/chats/` |
| Worlds | `data/default-user/worlds/` |
| Groups | `data/default-user/groups/` |
| Settings | `data/default-user/settings.json` |
| Presets | `data/default-user/presets/` |
| Personas | `data/default-user/personas/` |
| Backgrounds | `data/default-user/backgrounds/` |
| Themes | `data/default-user/themes/` |

## Security

- Your GitHub token is stored in SillyTavern's extension settings on the server
- It is **never** sent to the browser unmasked
- All git error messages have the token redacted before reaching the client

## Troubleshooting

| Issue | Solution |
|-------|----------|
| "Authentication failed" | Check your token has `Contents: Read and write` permission for the correct repository |
| "Repository not found" | Verify the repo name format: `username/repo-name` (case-sensitive) |
| "A sync operation is already in progress" | Wait for the current operation to complete |
| Large initial sync takes too long | This is normal on first push; subsequent pushes are incremental |