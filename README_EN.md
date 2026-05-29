# GitHub Data Sync for SillyTavern

[中文](README.md) | English

Sync SillyTavern data to a private GitHub repository — characters, chats, worlds, settings, and more. Push manually or on a timer. Pull to restore on any device.

## Features

- **Manual push/pull** via slash commands (`/sync-push`, `/sync-pull`, `/sync-status`)
- **Auto-push** on a configurable interval
- **Selectable data categories** — sync only what you need
- **Test connection** button to verify your repo and token
- **Sync log** with the last 10 operations
- **Token security** — PAT stored server-side, never exposed to the frontend
- **Auto-update** — plugin updates itself on server restart

## Prerequisites

1. A **GitHub repository** (private recommended) for storing your data
2. A **Personal Access Token** with repo access

### Create a GitHub repository

Create a **private** repository on GitHub (e.g. `my-st-backup`). Leave it empty (no README, no .gitignore).

### Create a Personal Access Token

1. Go to [GitHub Settings > Developer settings > Personal access tokens > Fine-grained tokens](https://github.com/settings/tokens?type=beta)
2. Click "Generate new token"
3. Under "Repository access", select "Only select repositories" and choose your backup repo
4. Under "Permissions" > "Contents", set to **Read and write**
5. Generate and copy the token (starts with `github_pat_`)

## Installation

### Step 1: Enable server plugins

In `SillyTavern/config.yaml`, add or set:

```yaml
enableServerPlugins: true
```

### Step 2: Install the plugin

```bash
cd SillyTavern/plugins
git clone https://github.com/JOJO666888888/sillytavern-github-sync.git github-data-sync
cd github-data-sync
npm install
```

### Step 3: Restart SillyTavern

The plugin auto-deploys its frontend extension on startup. Restart and refresh the page.

### Step 4: Configure

1. Open SillyTavern in your browser
2. Go to **Extensions** settings (puzzle piece icon in top bar)
3. Find the **GitHub Data Sync** section
4. Fill in:
   - **GitHub Repository**: `your-username/your-repo-name`
   - **Branch**: `main` (or your preferred branch)
   - **Personal Access Token**: paste your token
5. Click **Test Connection** to verify
6. Select which data categories to sync
7. Optionally enable auto-push

## Usage

### Slash Commands

| Command | Action |
|---------|--------|
| `/sync-push` | Push local data to GitHub |
| `/sync-pull` | Pull latest data from GitHub and restore locally |
| `/sync-status` | Show current sync status and recent log entries |

### Floating Button

A floating button (bottom-right corner) provides quick access to push, pull, and status.

### Auto-Push

Enable in settings to automatically push at a regular interval (minimum 5 minutes).

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
- The sync repository is stored under `data/default-user/.github-data-sync/`

## Troubleshooting

| Issue | Solution |
|-------|----------|
| Plugin not loading | Check `enableServerPlugins: true` in config.yaml |
| Settings panel not appearing | Hard refresh browser (Ctrl+Shift+R) |
| "Authentication failed" | Verify token has `Contents: Read and write` for the correct repo |
| "Repository not found" | Check repo name format: `username/repo-name` (case-sensitive) |
| "A sync operation is already in progress" | Wait for the current operation to complete |
| Large first sync takes long | Normal on first push; subsequent pushes are incremental |
| Plugin not updating | Check `enableServerPluginsAutoUpdate: true` in config.yaml |

## Updating

The plugin auto-updates on server restart. To update manually:

```bash
cd SillyTavern/plugins/github-data-sync
git pull origin main
npm install
```