# GitHub Data Sync for SillyTavern

[English](README_EN.md) | 中文

将 SillyTavern 数据同步到 GitHub 私有仓库 —— 包括角色卡、聊天记录、世界书、设置等。支持手动推送/拉取，也可定时自动推送。

## 功能

- **手动推送/拉取** —— 通过斜杠命令（`/sync-push`、`/sync-pull`、`/sync-status`）
- **定时自动推送** —— 可配置间隔时间，自动备份数据
- **按类别选择同步内容** —— 只同步你需要的数据
- **连接测试** —— 一键验证仓库和 Token 是否配置正确
- **同步日志** —— 记录最近 10 次操作
- **Token 安全** —— PAT 存储在服务端，不会暴露给前端
- **自动更新** —— 服务器重启时自动拉取最新代码

## 前置条件

1. 一个 **GitHub 仓库**（建议设为私有）用于存储数据
2. 一个 **Personal Access Token（个人访问令牌）**，需要 repo 权限

### 创建 GitHub 仓库

在 GitHub 上创建一个**私有**仓库（例如 `my-st-backup`）。保持空仓库（不要添加 README 或 .gitignore）。

### 创建 Personal Access Token

1. 访问 [GitHub Settings > Developer settings > Personal access tokens > Fine-grained tokens](https://github.com/settings/tokens?type=beta)
2. 点击 "Generate new token"
3. 在 "Repository access" 中选择 "Only select repositories"，然后选择你的备份仓库
4. 在 "Permissions" > "Contents" 中，设置为 **Read and write**
5. 生成并复制 Token（以 `github_pat_` 开头）

## 重要：这是服务器插件，不是前端扩展

此插件需要在服务器端执行 Git 操作和文件读写，依赖 `simple-git` 等 npm 包，**必须安装到 `plugins/` 目录**。

**不能用酒馆自带的「安装扩展」功能安装** —— 酒馆的内置安装器只处理前端扩展（`public/scripts/extensions/third-party/`），不会执行 `npm install`，也不会加载到服务器插件系统。用它安装的话插件不会有任何效果。

请按下面的步骤手动安装。

## 安装

### 第一步：启用服务器插件

在 `SillyTavern/config.yaml` 中添加或修改：

```yaml
enableServerPlugins: true
```

### 第二步：安装插件

```bash
cd SillyTavern/plugins
git clone https://github.com/JOJO666888888/sillytavern-github-sync.git github-data-sync
cd github-data-sync
npm install
```

### 第三步：重启 SillyTavern

插件会在启动时自动部署前端扩展。重启后刷新浏览器页面。

### 第四步：配置

1. 在浏览器中打开 SillyTavern
2. 进入 **扩展** 设置（顶部工具栏的拼图图标）
3. 找到 **GitHub Data Sync** 区域
4. 填写以下信息：
   - **GitHub Repository**：`你的用户名/仓库名`
   - **Branch**：`main`（或你使用的分支）
   - **Personal Access Token**：粘贴你的 Token
5. 点击 **Test Connection** 验证配置
6. 选择要同步的数据类别
7. 可选：启用自动推送

## 使用方式

### 斜杠命令

| 命令 | 功能 |
|------|------|
| `/sync-push` | 将本地数据推送到 GitHub |
| `/sync-pull` | 从 GitHub 拉取最新数据并恢复到本地 |
| `/sync-status` | 显示当前同步状态和最近的日志条目 |

### 悬浮按钮

页面右下角有一个悬浮按钮，可快速执行推送、拉取和查看状态。

### 自动推送

在设置中启用后，会按固定间隔自动推送数据（最短间隔为 5 分钟）。

### 拉取确认

默认情况下，`/sync-pull` 会在覆盖本地数据前弹出确认对话框。可在设置中关闭此确认。

## 多端同步指南

插件支持在不同设备间同步数据，使用前请务必了解以下注意事项。

### 首次使用（设备 A）

1. 安装插件，配置仓库和 Token
2. 选择要同步的数据类别，点击保存
3. 执行 `/sync-push` 将数据推送到 GitHub

### 在其他设备上同步（设备 B）

1. 安装插件，配置**同一个仓库**和 Token
2. 执行 `/sync-pull` 从 GitHub 拉取数据
3. 设备 B 的本地数据将被仓库中的数据**覆盖**

### 注意事项

1. **不要在多个设备上同时开启自动推送** —— 建议只在主设备上启用 `autoPush`，其他设备手动同步。多设备同时推送可能导致冲突。
2. **拉取前先推送** —— 每次切换设备使用前，先在当前设备上 `/sync-push`，再到另一个设备上 `/sync-pull`，避免数据丢失。
3. **「设置」类别谨慎同步** —— `settings.json` 包含所有扩展的配置，不同设备安装的扩展可能不同，跨设备同步设置可能导致部分扩展配置异常。建议只同步真正需要共享的类别。
4. **首次拉取会覆盖** —— 新设备上首次 `/sync-pull` 会用仓库数据覆盖本地数据，如有重要数据请先备份。
5. **大文件注意** —— 角色卡图片、聊天附件等可能较大，首次同步需要较长时间。
6. **插件配置不会同步** —— GitHub Token、仓库地址等配置在推送/拉取时自动过滤，不会在设备间共享（每个设备需要独立配置）。

## 数据类别

| 类别 | 路径 |
|------|------|
| 角色 (Characters) | `data/default-user/characters/` |
| 聊天 (Chats) | `data/default-user/chats/` |
| 世界书 (Worlds) | `data/default-user/worlds/` |
| 群组 (Groups) | `data/default-user/groups/` |
| 设置 (Settings) | `data/default-user/settings.json` |
| 预设 (Presets) | `data/default-user/presets/` |
| 人格 (Personas) | `data/default-user/personas/` |
| 背景 (Backgrounds) | `data/default-user/backgrounds/` |
| 主题 (Themes) | `data/default-user/themes/` |

> **关于 API 配置：** 此插件**不涉及** SillyTavern 的 API 配置（如 OpenRouter Key、Claude Key 等）。插件的 GitHub Token 等配置在推送时自动过滤，拉取时自动保留本地值，**不会被同步到仓库中**。如果你不希望 `settings.json` 中的其他扩展设置在不同设备间同步，取消勾选「设置 (Settings)」类别即可。

## 安全

- GitHub Token 存储在 SillyTavern 服务端的扩展设置中
- Token **绝不会**以明文形式发送到浏览器
- 所有 git 错误信息中的 Token 都会被脱敏后才发送到客户端
- 同步仓库本地副本位于 `data/default-user/.github-data-sync/`

## 常见问题

| 问题 | 解决方法 |
|------|----------|
| 插件未加载 | 检查 `config.yaml` 中是否设置了 `enableServerPlugins: true` |
| 设置面板不显示 | 强制刷新浏览器（Ctrl+Shift+R） |
| "Authentication failed" | 确认 Token 具有 `Contents: Read and write` 权限，且授权给了正确的仓库 |
| "Repository not found" | 检查仓库名格式：`用户名/仓库名`（区分大小写） |
| "A sync operation is already in progress" | 等待当前操作完成后再试 |
| 首次同步数据量大，耗时长 | 正常现象；后续同步是增量的，会很快 |
| 插件未自动更新 | 检查 `config.yaml` 中是否设置了 `enableServerPluginsAutoUpdate: true` |

## 更新

插件会在服务器重启时自动更新。如需手动更新：

```bash
cd SillyTavern/plugins/github-data-sync
git pull origin main
npm install
```