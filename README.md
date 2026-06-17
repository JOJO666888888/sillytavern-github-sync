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

## 多端同步规范

如果你在多个设备（如台式机、笔记本、云服务器）上安装了此插件并配置了同一个 GitHub 仓库，**请严格遵守以下规范**，否则可能导致数据丢失或冲突。

### 铁律（必须遵守）

**1. 只在一个设备上开启自动推送。** 其他所有设备关闭 `autoPush`，全靠手动操作。推荐在主设备（日常使用最频繁的那台）上开启。

**2. 每次使用前先拉取，使用结束后推送。** 这是多端同步的核心流程，下面有详细说明。

**3. 绝对不要在两台设备上同时操作同一个角色/聊天，然后分别推送。** 后推送的设备会覆盖先推送的数据。

### 日常操作流程

#### 场景一：单主设备 + 辅助设备（推荐）

主设备（台式机）开启 `autoPush`，间隔建议 30 分钟。辅助设备（笔记本）关闭自动推送。

**在辅助设备上使用时：**

```
打开酒馆 → /sync-pull → 正常使用 → /sync-push → 关闭
```

就这么简单。拉取最新的，用完推回去。

#### 场景二：两台设备都用（无自动推送）

两台设备都关闭 `autoPush`，完全手动。

```
设备 A 上：
  打开酒馆 → /sync-pull → 使用 → /sync-push → 关闭

切换到设备 B 上：
  打开酒馆 → /sync-pull → 使用 → /sync-push → 关闭

回到设备 A：
  打开酒馆 → /sync-pull → 使用 → /sync-push → 关闭
  ...以此类推
```

#### 场景三：服务器长期运行

服务器 24 小时运行，开启 `autoPush`，其他设备手动。

```
笔记本：
  打开酒馆 → /sync-pull → 使用 → /sync-push → 关闭

手机/平板：
  打开酒馆 → /sync-pull → 使用 → /sync-push → 关闭
```

服务器自动推送可以保证即使你忘记在辅助设备上推送，数据也会被主设备保存。

### 出问题怎么办

| 情况 | 处理方法 |
|------|----------|
| 忘记推送就换设备了 | 回到原来的设备推送一次，再到当前设备拉取 |
| 两台设备都修改了数据 | 以你**更想保留**的那台设备为准，先推送它，另一台再拉取（注意：另一台的修改会丢失） |
| 拉取后数据不对 | 检查 GitHub 仓库的 commit 历史，看最后一次推送是哪个设备、什么时间 |
| 推送冲突 (rejected) | 先 `/sync-pull` 合并远程更改，再 `/sync-push` |
| 想查看当前状态 | 使用 `/sync-status` 查看 git 状态和最近的同步日志 |

### 建议的数据类别配置

根据不同使用场景，建议勾选不同的类别：

| 类别 | 全设备同步 | 仅备份 | 不建议同步 |
|------|:--:|:--:|:--:|
| 角色 (Characters) | ✓ | | |
| 聊天 (Chats) | ✓ | | |
| 世界书 (Worlds) | ✓ | | |
| 群组 (Groups) | ✓ | | |
| 设置 (Settings) | | ✓ | |
| 预设 (Presets) | | ✓ | |
| 人格 (Personas) | ✓ | | |
| 背景 (Backgrounds) | | ✓ | |
| 主题 (Themes) | | ✓ | |

> 「全设备同步」= 在不同设备上保持一致；「仅备份」= 备份到 GitHub 但不建议跨设备覆盖，因为不同设备可能有不同的偏好设置。

### 一个典型的多端一天

```
早上 - 笔记本上：
  /sync-pull              ← 拉取昨晚台式机的更改
  跟角色聊了一会儿
  /sync-push              ← 推送，推完关机出门

白天 - 手机（浏览器访问）：
  /sync-pull              ← 拉取早上笔记本的聊天
  抽卡，调整世界书设定
  /sync-push              ← 推完关掉

晚上 - 台式机上（autoPush 开启）：
  /sync-pull              ← 拉取白天的改动
  继续聊天...
  （30 分钟后自动推送）
  继续聊天...
  关机                  ← autoPush 在关机前已自动保存

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

## 更新日志

### 2026-06-17

**新功能**
- **扩展路径备份** — 扫描已安装的第三方扩展，提取 Git 仓库地址，保存为 JSON 同步到云端
- **一键安装缺失扩展** — 比对云端备份与本地，自动安装缺失的扩展
- **查看云端备份列表** — 在界面中查看已同步到仓库的扩展列表
- **生成备份并推送** — 一键扫描本地扩展并推送到 GitHub
- **Git 操作防卡死** — 设置 `GIT_TERMINAL_PROMPT=0`，Token 无效时直接报错不再等待密码输入

**修复**
- 修复预设（presets）路径映射错误（指向不存在的 `presets/` 目录，改为 `OpenAI Settings/`）
- 修复人格（personas）路径映射错误（指向不存在的 `personas/` 目录，改为 `User Avatars/`）
- 修复本地扫描错误覆盖云端备份文件的问题
- 扩展面板按钮文字颜色改为黑色，提升可读性

### 2026-06-14

**新功能**
- **双模式拉取** — 新增「拉取模式」设置项：
  - **合并模式**（默认）：拉取时尝试合并远程和本地数据，如遇冲突弹出可视化解决界面
  - **覆盖模式**：拉取前自动备份，用远程文件覆盖本地，永不产生冲突
- **冲突解决中心** — 合并模式下发生冲突时，弹出可视化界面：
  - 每个冲突文件可选「保留本地」「保留远程」「手动编辑」
  - 手动编辑器支持 JSON 格式校验，防止损坏数据
  - 全局快捷操作：全部保留本地（强制推送）/ 全部保留远程
- **备份刷新按钮** — 备份列表新增手动刷新按钮
- **多用户隔离** — 支持 SillyTavern 多角色登录，每个用户独立配置和数据

**修复**
- 修复空仓库（无分支）clone 失败的问题
- 修复冲突标记检测误报（`=======` 在普通内容中也被判定为冲突）
- 修复手动编辑冲突文件时"禁止访问"的错误
- 斜杠命令改为动态加载，避免因模块路径不兼容导致整个插件无法加载

### 2026-06-05

- 修复配置持久化问题（从 extension_settings 迁移到独立文件）
- 修复脱敏 Token 覆盖真实 Token 的问题
- 新增拉取进度跟踪
- 新增拉取前自动备份功能

## 更新

插件会在服务器重启时自动更新。如需手动更新：

```bash
cd SillyTavern/plugins/github-data-sync
git pull origin main
npm install
```