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

## Important: Server Plugin, NOT a Frontend Extension

This plugin performs Git operations and file I/O on the server side and depends on npm packages like `simple-git`. It **must be installed in the `plugins/` directory**.

**Do NOT use SillyTavern's built-in "Install Extension" feature** — it only handles frontend extensions (`public/scripts/extensions/third-party/`), does not run `npm install`, and does not load into the server plugin system. Installing via that method will have no effect.

Please follow the manual installation steps below.

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

## Multi-Device Sync Rules

If you have this plugin installed on multiple devices (e.g., desktop, laptop, cloud server) configured with the same GitHub repo, **follow these rules strictly** to avoid data loss or conflicts.

### Hard Rules (Must Follow)

**1. Enable auto-push on only ONE device.** All other devices must have `autoPush` disabled and sync manually. Recommend enabling it on your most frequently used primary device.

**2. Pull when you start, push when you're done.** This is the core workflow for multi-device sync. See below for details.

**3. NEVER edit the same character/chat on two devices simultaneously and push both.** The second push will overwrite the first one's data.

### Daily Workflows

#### Scenario 1: Primary device + secondary device (Recommended)

Primary device (desktop) has `autoPush` enabled at 30-minute intervals. Secondary device (laptop) has auto-push off.

**When using the secondary device:**

```
Open ST → /sync-pull → use normally → /sync-push → close
```

That's it. Pull latest, use, push back.

#### Scenario 2: Two devices, both manual

Both devices have `autoPush` off. Everything is manual.

```
On Device A:
  Open ST → /sync-pull → use → /sync-push → close

Switch to Device B:
  Open ST → /sync-pull → use → /sync-push → close

Back to Device A:
  Open ST → /sync-pull → use → /sync-push → close
  ...repeat
```

#### Scenario 3: Always-on server

Server runs 24/7 with `autoPush` enabled. Other devices sync manually.

```
Laptop:
  Open ST → /sync-pull → use → /sync-push → close

Phone/Tablet:
  Open ST → /sync-pull → use → /sync-push → close
```

The server's auto-push acts as a safety net — even if you forget to push from a secondary device, data was already saved by the server.

### Troubleshooting

| Situation | What to do |
|-----------|------------|
| Forgot to push before switching devices | Go back to the original device and push, then pull on the current device |
| Both devices have modified data | Choose the device whose data you **want to keep**, push from it first, then pull on the other (the other's changes will be lost) |
| Data looks wrong after pulling | Check the commit history on your GitHub repo to see when and from which device the last push happened |
| Push rejected (conflict) | Run `/sync-pull` first to merge remote changes, then `/sync-push` |
| Check current sync state | Use `/sync-status` to view git status and recent sync log |

### Recommended Category Config

| Category | Cross-device sync | Backup only | Not recommended |
|----------|:--:|:--:|:--:|
| Characters | ✓ | | |
| Chats | ✓ | | |
| Worlds | ✓ | | |
| Groups | ✓ | | |
| Settings | | ✓ | |
| Presets | | ✓ | |
| Personas | ✓ | | |
| Backgrounds | | ✓ | |
| Themes | | ✓ | |

> "Cross-device sync" = keep consistent across devices; "Backup only" = stored on GitHub but not recommended for cross-device overwriting, since different devices may have different preferences.

### A Typical Multi-Device Day

```
Morning - on laptop:
  /sync-pull              ← pull last night's desktop changes
  chat for a while
  /sync-push              ← push, then shut down

Daytime - on phone (browser):
  /sync-pull              ← pull morning's laptop chat
  draw cards, edit world info
  /sync-push              ← push and close

Evening - on desktop (autoPush on):
  /sync-pull              ← pull daytime changes
  continue chatting...
  (auto-push after 30 min)
  continue chatting...
  shutdown               ← autoPush already saved before shutdown

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

> **About API configuration:** This plugin does **NOT** touch SillyTavern's API settings (e.g., OpenRouter Key, Claude Key, etc.). The plugin's own GitHub Token is automatically stripped before push and preserved locally during pull — it is **never synced to the repository**. If you prefer not to sync other extension settings in `settings.json` across devices, simply uncheck the "Settings" category.

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

## Changelog

### 2026-06-14

**New Features**
- **Dual pull modes** — New "Pull Mode" setting:
  - **Merge mode** (default): Attempts to merge remote and local data; shows a visual conflict resolver if conflicts arise
  - **Overwrite mode**: Auto-backs up before pull, overwrites local with remote files, never produces conflicts
- **Conflict resolution center** — When merge mode detects conflicts, a visual panel appears:
  - Per-file options: "Keep Local", "Keep Remote", "Manual Edit"
  - Manual editor with JSON validation to prevent corrupted data
  - Global actions: Keep All Local (force push) / Keep All Remote
- **Backup refresh button** — Manual refresh for the backup list
- **Multi-user isolation** — Supports SillyTavern multi-character login with per-user configs and data

**Fixes**
- Fix clone failure for empty repos (no branches)
- Fix false positives in conflict marker detection (`=======` in normal content was flagged as conflict)
- Fix "Forbidden" error when editing conflict files manually
- Slash commands now load via dynamic import to prevent plugin failure from incompatible module paths

### 2026-06-05

- Fix config persistence (migrate from extension_settings to standalone file)
- Fix masked token overwriting real token on save
- Add push/pull progress tracking
- Add auto-backup before pull

## Updating

The plugin auto-updates on server restart. To update manually:

```bash
cd SillyTavern/plugins/github-data-sync
git pull origin main
npm install
```