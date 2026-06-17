// GitHub Data Sync - Frontend Extension for SillyTavern
// Auto-deployed to: public/scripts/extensions/third-party/github-data-sync/index.js

const API_BASE = '/api/plugins/github-data-sync';

// ===================== API helpers =====================

let _csrfToken = null;

async function getCsrfToken() {
    if (_csrfToken) return _csrfToken;
    try {
        const resp = await fetch('/csrf-token');
        const data = await resp.json();
        _csrfToken = data.token;
        return _csrfToken;
    } catch { return ''; }
}

async function apiCall(method, endpoint, body) {
    const headers = { 'Content-Type': 'application/json' };
    if (method !== 'GET') {
        const token = await getCsrfToken();
        if (token) headers['X-CSRF-Token'] = token;
    }
    const opts = { method, headers };
    if (body) opts.body = JSON.stringify(body);
    const resp = await fetch(`${API_BASE}${endpoint}`, opts);
    const data = await resp.json();
    if (!data.success) {
        throw new Error(data.error || data.errors?.join(', ') || 'Unknown error');
    }
    return data;
}

async function loadConfig() {
    try { const data = await apiCall('GET', '/config'); return data.config || {}; }
    catch { return {}; }
}

async function saveConfig(partial) {
    try { const data = await apiCall('PUT', '/config', partial); return data.config || {}; }
    catch (err) { toastr.error(`保存失败: ${err.message}`, 'GitHub Sync'); return null; }
}

function escapeHtml(str) {
    return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ===================== Sync operations =====================

async function doPush() {
    try {
        toastr.info('正在推送到 GitHub...', 'GitHub Sync');
        const result = await apiCall('POST', '/push');
        if (result.skipped) {
            toastr.warning('没有需要推送的更改。', 'GitHub Sync');
        } else {
            const files = result.filesChanged?.join(', ') || '';
            toastr.success('推送成功: ' + files, 'GitHub Sync');
        }
        refreshAllUI();
    } catch (err) {
        toastr.error('推送失败: ' + err.message, 'GitHub Sync');
    }
}

async function doPull() {
    const cfg = await loadConfig();
    if (cfg.pullConfirmation !== false) {
        const confirmed = await showConfirmDialog(
            '确认从 GitHub 拉取？',
            cfg.pullMode === 'remote-first'
                ? '覆盖模式：远程数据将覆盖本地（拉取前会自动备份）。是否继续？'
                : '合并模式：将尝试合并远程和本地数据。是否继续？'
        );
        if (!confirmed) return;
    }
    try {
        toastr.info('正在从 GitHub 拉取数据...', 'GitHub Sync');
        const result = await apiCall('POST', '/pull');
        if (result.hasConflicts && result.conflictFiles?.length > 0) {
            toastr.warning('检测到 ' + result.conflictFiles.length + ' 个冲突文件', 'GitHub Sync');
            await showConflictPanel(result.conflictFiles);
        } else {
            const files = result.filesRestored?.join(', ') || '';
            toastr.success('拉取成功: ' + files, 'GitHub Sync');
        }
        refreshAllUI();
    } catch (err) {
        toastr.error('拉取失败: ' + err.message, 'GitHub Sync');
    }
}

async function doStatus() {
    try {
        const data = await apiCall('GET', '/status');
        let msg = 'GitHub Sync 状态\n\n';
        msg += `自动推送: ${data.autoPushEnabled ? '开启 (每' + data.autoPushInterval + '分钟)' : '关闭'}\n`;
        msg += `配置有效: ${data.configValid ? '是' : '否'}\n`;
        if (data.gitStatus) {
            const gs = data.gitStatus;
            msg += `分支: ${gs.current}, 领先: ${gs.ahead}, 落后: ${gs.behind}\n`;
            msg += `有未推送更改: ${gs.hasChanges ? '是' : '否'}\n`;
        }
        if (data.syncLog?.length > 0) {
            msg += `\n最近: ${data.syncLog[0].message}`;
        }
        toastr.info(msg, 'GitHub Sync', { timeOut: 10000 });
    } catch (err) {
        toastr.error('状态检查失败: ' + err.message, 'GitHub Sync');
    }
}

// ===================== Dialog =====================

function showConfirmDialog(title, message) {
    return new Promise((resolve) => {
        const id = 'sync-confirm-' + Date.now();
        const html = [
            '<div id="' + id + '" class="dialog-modal">',
            '<div class="dialog-content">',
            '<h4>' + escapeHtml(title) + '</h4>',
            '<p>' + escapeHtml(message) + '</p>',
            '<div class="dialog-buttons">',
            '<button class="btn btn-danger" data-action="confirm">确认</button>',
            '<button class="btn btn-secondary" data-action="cancel">取消</button>',
            '</div></div></div>'
        ].join('');
        $('body').append(html);
        $('#' + id).on('click', '[data-action]', function () {
            $('#' + id).remove();
            resolve($(this).data('action') === 'confirm');
        });
    });
}

// ===================== UI =====================

function updateStatusUI(data) {
    // Status indicator
    const $s = $('#sync-status-indicator');
    if ($s.length) {
        if (data.syncInProgress) $s.text('同步中...').css('color', '#f0ad4e');
        else if (!data.configValid) $s.text('未配置').css('color', '#d9534f');
        else $s.text('就绪').css('color', '#5cb85c');
    }
    // Log
    const $log = $('#sync-log-container');
    if ($log.length && data.syncLog) {
        const icons = { success: '✅', error: '❌', warning: '⚠', info: 'ℹ' };
        const entries = data.syncLog.slice(0, 10).map(function (e) {
            const time = new Date(e.timestamp).toLocaleTimeString();
            const icon = icons[e.type] || '';
            return '<div class="sync-log-entry sync-log-' + e.type + '">' + icon + ' ' + time + ' - ' + escapeHtml(e.message) + '</div>';
        }).join('');
        $log.html(entries || '<div class="sync-log-entry">暂无同步记录。</div>');
    }
}

async function refreshAllUI() {
    try {
        const data = await apiCall('GET', '/status');
        updateStatusUI(data);
    } catch (e) { /* ignore */ }
}

// ===================== Backup Management =====================

async function loadBackupList() {
    try {
        var data = await apiCall('GET', '/backups');
        var $list = $('#sync-backup-list');
        if (!data.backups || data.backups.length === 0) {
            $list.html('<div style="color:#777;font-size:12px;">暂无备份。</div>');
            return;
        }
        var html = data.backups.map(function (b) {
            var ts = b.id.replace(/T/g, ' ').substring(0,16);
            return '<div style="display:flex;align-items:center;gap:4px;padding:3px 0;border-bottom:1px solid #222;font-size:12px;">' +
                '<span style="flex:1;color:#ccc;">' + escapeHtml(ts) + ' (' + escapeHtml(b.sizeFormatted) + ')</span>' +
                '<button class="btn btn-sm sync-backup-restore" data-id="' + escapeHtml(b.id) + '" title="恢复">恢复</button>' +
                '<button class="btn btn-sm sync-backup-delete" data-id="' + escapeHtml(b.id) + '" title="删除">删除</button>' +
                '</div>';
        }).join('');
        $list.html(html);
    } catch { /* ignore */ }
}

async function doBackups() {
    try {
        var data = await apiCall('GET', '/backups');
        if (!data.backups || data.backups.length === 0) {
            toastr.info('暂无备份。', 'GitHub Sync');
            return;
        }
        var msg = '备份列表:\n' + data.backups.map(function (b, i) {
            return '[' + (i + 1) + '] ' + b.id.replace(/T/g, ' ').substring(0, 16) + ' - ' + b.sizeFormatted + ' (' + b.categories.join(', ') + ')';
        }).join('\n');
        toastr.info(msg, 'GitHub Sync', { timeOut: 15000 });
    } catch (err) { toastr.error('获取备份失败: ' + err.message, 'GitHub Sync'); }
}

async function doRestore(index) {
    try {
        var data = await apiCall('GET', '/backups');
        if (!data.backups || data.backups.length === 0) {
            toastr.info('暂无备份。', 'GitHub Sync');
            return;
        }
        var idx = (typeof index === 'number') ? index - 1 : 0;
        if (idx < 0 || idx >= data.backups.length) {
            toastr.error('无效的备份序号。使用 /sync-backups 查看备份列表。', 'GitHub Sync');
            return;
        }
        var backupId = data.backups[idx].id;
        var confirmed = await showConfirmDialog('确认恢复备份？', '将用备份（' + backupId.replace(/T/g, ' ').substring(0, 16) + '）覆盖当前数据？');
        if (!confirmed) return;
        toastr.info('正在恢复备份...', 'GitHub Sync');
        var result = await apiCall('POST', '/backup/restore', { backupId: backupId });
        toastr.success('已恢复: ' + result.restored.join(', '), 'GitHub Sync');
        refreshAllUI();
    } catch (err) { toastr.error('恢复失败: ' + err.message, 'GitHub Sync'); }
}

// ===================== Conflict Resolution =====================

function showConflictPanel(conflictFiles) {
    return new Promise(function (resolve) {
        var id = 'sync-conflict-' + Date.now();
        var fileRows = conflictFiles.map(function (f) {
            return '<div class="sync-conflict-file" data-file="' + escapeHtml(f) + '">' +
                '<span class="sync-conflict-name">' + escapeHtml(f) + '</span>' +
                '<div class="sync-conflict-btns">' +
                '<button class="btn btn-sm btn-primary" data-action="ours" title="保留本地版本">本地</button>' +
                '<button class="btn btn-sm btn-secondary" data-action="theirs" title="保留远程版本">远程</button>' +
                '<button class="btn btn-sm" data-action="edit" title="手动编辑">编辑</button>' +
                '</div></div>';
        }).join('');

        var html = '<div id="' + id + '" class="dialog-modal">' +
            '<div class="dialog-content" style="max-width:600px;">' +
            '<h4>检测到同步冲突</h4>' +
            '<p>以下文件存在冲突，请选择解决方式：</p>' +
            '<div class="sync-conflict-panel">' + fileRows + '</div>' +
            '<div class="sync-conflict-global">' +
            '<button class="btn btn-danger" data-action="all-ours">全部保留本地（强制推送）</button>' +
            '<button class="btn btn-secondary" data-action="all-theirs">全部保留远程</button>' +
            '<button class="btn btn-secondary" data-action="close" style="margin-left:auto;">关闭</button>' +
            '</div></div></div>';

        $('body').append(html);

        var remaining = conflictFiles.slice();
        var $panel = $('#' + id);

        function updateRemaining() {
            $panel.find('.sync-conflict-file').each(function () {
                var f = $(this).data('file');
                if (remaining.indexOf(f) === -1) {
                    $(this).css('opacity', '0.4').find('.sync-conflict-btns button').prop('disabled', true);
                }
            });
            if (remaining.length === 0) {
                toastr.success('所有冲突已解决！', 'GitHub Sync');
                $panel.remove();
                resolve(true);
            }
        }

        // Per-file actions
        $panel.on('click', '[data-action="ours"]', function () {
            var file = $(this).closest('.sync-conflict-file').data('file');
            apiCall('POST', '/resolve-conflict', { fileName: file, strategy: 'ours' }).then(function () {
                remaining = remaining.filter(function (f) { return f !== file; });
                updateRemaining();
            }).catch(function (err) { toastr.error(err.message, 'GitHub Sync'); });
        });

        $panel.on('click', '[data-action="theirs"]', function () {
            var file = $(this).closest('.sync-conflict-file').data('file');
            apiCall('POST', '/resolve-conflict', { fileName: file, strategy: 'theirs' }).then(function () {
                remaining = remaining.filter(function (f) { return f !== file; });
                updateRemaining();
            }).catch(function (err) { toastr.error(err.message, 'GitHub Sync'); });
        });

        $panel.on('click', '[data-action="edit"]', function () {
            var file = $(this).closest('.sync-conflict-file').data('file');
            showConflictEditor(file, id).then(function (resolved) {
                if (resolved) {
                    remaining = remaining.filter(function (f) { return f !== file; });
                    updateRemaining();
                }
            });
        });

        // Global actions
        $panel.on('click', '[data-action="all-ours"]', function () {
            showConfirmDialog('确认全部保留本地？', '此操作将强制推送本地数据到远程仓库，其他设备的修改将被覆盖。').then(function (ok) {
                if (!ok) return;
                apiCall('POST', '/force-push').then(function () {
                    toastr.success('已强制推送（保留本地）', 'GitHub Sync');
                    remaining = [];
                    updateRemaining();
                    refreshAllUI();
                }).catch(function (err) { toastr.error(err.message, 'GitHub Sync'); });
            });
        });

        $panel.on('click', '[data-action="all-theirs"]', function () {
            showConfirmDialog('确认全部保留远程？', '本地冲突文件将被远程版本覆盖。').then(function (ok) {
                if (!ok) return;
                apiCall('POST', '/resolve-conflict', { fileName: remaining[0], strategy: 'theirs' }).then(function () {
                    // Resolve remaining one by one
                    var chain = Promise.resolve();
                    remaining.forEach(function (f) {
                        chain = chain.then(function () {
                            return apiCall('POST', '/resolve-conflict', { fileName: f, strategy: 'theirs' });
                        });
                    });
                    chain.then(function () {
                        toastr.success('已全部保留远程版本', 'GitHub Sync');
                        remaining = [];
                        updateRemaining();
                        refreshAllUI();
                    });
                }).catch(function (err) { toastr.error(err.message, 'GitHub Sync'); });
            });
        });

        $panel.on('click', '[data-action="close"]', function () {
            $panel.remove();
            resolve(remaining.length === 0);
        });
    });
}

function showConflictEditor(file, parentId) {
    return new Promise(function (resolve) {
        apiCall('GET', '/conflict-content?file=' + encodeURIComponent(file)).then(function (data) {
            var editorId = 'sync-editor-' + Date.now();
            var html = '<div id="' + editorId + '" class="dialog-modal">' +
                '<div class="dialog-content" style="max-width:700px;">' +
                '<h4>编辑: ' + escapeHtml(file) + '</h4>' +
                '<textarea class="sync-conflict-editor" spellcheck="false">' + escapeHtml(data.content) + '</textarea>' +
                '<div class="dialog-buttons" style="margin-top:8px;">' +
                '<button class="btn btn-primary" data-action="save">保存并解决</button>' +
                '<button class="btn btn-secondary" data-action="cancel">取消</button>' +
                '</div></div></div>';

            $('body').append(html);
            var $editor = $('#' + editorId);

            $editor.on('click', '[data-action="save"]', function () {
                var content = $editor.find('.sync-conflict-editor').val();
                apiCall('POST', '/resolve-conflict', { fileName: file, strategy: 'manual', content: content }).then(function () {
                    toastr.success('已保存并解决: ' + file, 'GitHub Sync');
                    $editor.remove();
                    resolve(true);
                }).catch(function (err) {
                    toastr.error('保存失败: ' + err.message, 'GitHub Sync');
                });
            });

            $editor.on('click', '[data-action="cancel"]', function () {
                $editor.remove();
                resolve(false);
            });
        }).catch(function (err) {
            toastr.error('读取文件失败: ' + err.message, 'GitHub Sync');
            resolve(false);
        });
    });
}

// ===================== Settings Panel =====================

function buildSettingsHtml() {
    // Simplified settings panel - all in one compact card
    return [
        '<div id="github-data-sync-settings" class="github-data-sync-panel">',

        // Repo Config
        '<div class="inline-drawer">',
        '<div class="inline-drawer-toggle inline-drawer-header"><b>仓库配置</b>',
        '<div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div></div>',
        '<div class="inline-drawer-content" style="padding:8px 12px;">',
        '<div class="form-group"><label>GitHub 仓库 <small>(用户名/仓库名)</small></label>',
        '<input type="text" id="sync-github-repo" class="text_pole" placeholder="用户名/仓库名"></div>',
        '<div class="form-group"><label>分支</label>',
        '<input type="text" id="sync-branch" class="text_pole" placeholder="main"></div>',
        '<div class="form-group"><label>个人访问令牌 (Token)</label>',
        '<div class="sync-token-row">',
        '<input type="password" id="sync-github-token" class="text_pole" placeholder="ghp_...">',
        '<button id="sync-toggle-token" class="btn btn-sm" type="button"><span class="fa fa-eye"></span></button></div>',
        '<small>需要 <code>repo</code> 权限。</small></div>',
        '<button id="sync-test-connection" class="btn btn-secondary" style="margin-top:6px;">测试连接</button>',
        '<span id="sync-test-result"></span></div></div>',

        // Data Selection
        '<div class="inline-drawer">',
        '<div class="inline-drawer-toggle inline-drawer-header"><b>同步数据选择</b>',
        '<div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div></div>',
        '<div class="inline-drawer-content" style="padding:8px 12px;"><div class="sync-checkbox-grid">',
        '<label class="checkbox_label"><input type="checkbox" id="sync-data-characters">角色 (Characters)</label>',
        '<label class="checkbox_label"><input type="checkbox" id="sync-data-chats">聊天 (Chats)</label>',
        '<label class="checkbox_label"><input type="checkbox" id="sync-data-worlds">世界书 (Worlds)</label>',
        '<label class="checkbox_label"><input type="checkbox" id="sync-data-groups">群组 (Groups)</label>',
        '<label class="checkbox_label"><input type="checkbox" id="sync-data-settings">设置 (Settings)</label>',
        '<label class="checkbox_label"><input type="checkbox" id="sync-data-presets">OpenAI 预设 (Presets)</label>',
        '<label class="checkbox_label"><input type="checkbox" id="sync-data-personas">人格头像 (Personas)</label>',
        '<label class="checkbox_label"><input type="checkbox" id="sync-data-backgrounds">背景 (Backgrounds)</label>',
        '<label class="checkbox_label"><input type="checkbox" id="sync-data-themes">主题 (Themes)</label>',
        '<label class="checkbox_label"><input type="checkbox" id="sync-data-extensions">扩展路径 (Extensions)</label>',
        '</div></div></div>',

        // Auto Push
        '<div class="inline-drawer">',
        '<div class="inline-drawer-toggle inline-drawer-header"><b>自动推送</b>',
        '<div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div></div>',
        '<div class="inline-drawer-content" style="padding:8px 12px;">',
        '<label class="checkbox_label"><input type="checkbox" id="sync-autopush-enabled">启用自动推送</label>',
        '<div class="form-group"><label>间隔时间（分钟，最少 5）</label>',
        '<input type="number" id="sync-autopush-interval" class="text_pole" min="5" value="30" step="5"></div>',
        '</div></div>',

        // Pull Mode
        '<div class="inline-drawer">',
        '<div class="inline-drawer-toggle inline-drawer-header"><b>拉取模式</b>',
        '<div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div></div>',
        '<div class="inline-drawer-content" style="padding:8px 12px;">',
        '<div class="sync-radio-group">',
        '<label class="checkbox_label"><input type="radio" name="sync-pull-mode" value="local-first" checked>合并模式（以本地为准）</label>',
        '<label class="checkbox_label"><input type="radio" name="sync-pull-mode" value="remote-first">覆盖模式（以远程为准）</label>',
        '</div>',
        '<small style="color:#777;display:block;margin-top:4px;">覆盖模式：拉取前自动备份，用远程文件覆盖本地，不会产生冲突。</small>',
        '</div></div>',

        // Auto Backup
        '<div class="inline-drawer">',
        '<div class="inline-drawer-toggle inline-drawer-header"><b>备份</b>',
        '<div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div></div>',
        '<div class="inline-drawer-content" style="padding:8px 12px;">',
        '<label class="checkbox_label"><input type="checkbox" id="sync-autobackup-enabled">拉取前自动备份</label>',
        '<div class="form-group"><label>保留备份数量（1-50）</label>',
        '<input type="number" id="sync-autobackup-max" class="text_pole" min="1" max="50" value="5"></div>',
        '<button id="sync-backup-now" class="btn btn-secondary">手动备份</button>',
        '<button id="sync-backup-refresh" class="btn btn-sm" style="margin-left:4px;" title="刷新备份列表"><span class="fa fa-refresh"></span></button>',
        '<div id="sync-backup-list" style="margin-top:8px;max-height:150px;overflow-y:auto;"></div>',
        '</div></div>',

        // Extensions Backup
        '<div class="inline-drawer">',
        '<div class="inline-drawer-toggle inline-drawer-header"><b>扩展路径备份</b>',
        '<div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div></div>',
        '<div class="inline-drawer-content" style="padding:8px 12px;">',
        '<button id="sync-ext-scan" class="btn btn-secondary">获取列表</button>',
        '<small style="color:#777;display:block;margin-top:4px;">扫描已安装的第三方扩展，提取 Git 仓库地址。列表会随数据同步到云端。</small>',
        '<textarea id="sync-ext-list" class="text_pole" readonly style="margin-top:8px;width:100%;min-height:80px;max-height:200px;font-size:12px;font-family:monospace;resize:vertical;" placeholder="点击「获取列表」扫描已安装的扩展..."></textarea>',
        '</div></div>',

        // Controls & Log
        '<div class="inline-drawer">',
        '<div class="inline-drawer-toggle inline-drawer-header"><b>操作与状态</b>',
        '<div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div></div>',
        '<div class="inline-drawer-content" style="padding:8px 12px;">',
        '<div class="sync-controls">',
        '<button id="sync-push-now" class="btn btn-primary">立即推送</button>',
        '<button id="sync-pull-now" class="btn btn-primary">立即拉取</button>',
        '<span class="sync-status-label">状态：<span id="sync-status-indicator">检查中...</span></span>',
        '</div>',
        '<h4 style="margin-top:12px;">同步日志</h4>',
        '<div id="sync-log-container" class="sync-log"><div class="sync-log-entry">加载中...</div></div>',
        '</div></div>',

        '</div>', // end panel

        // Styles
        '<style>',
        '.github-data-sync-panel .inline-drawer{margin-bottom:4px;}',
        '.github-data-sync-panel .form-group{margin-bottom:8px;}',
        '.github-data-sync-panel .form-group label{display:block;margin-bottom:2px;font-size:13px;color:#aaa;}',
        '.github-data-sync-panel .form-group small{display:block;margin-top:2px;color:#777;}',
        '.sync-token-row{display:flex;gap:4px;align-items:center;}',
        '.sync-token-row input{flex:1;}',
        '.sync-checkbox-grid{display:grid;grid-template-columns:1fr 1fr 1fr;gap:4px 12px;}',
        '.sync-checkbox-grid .checkbox_label{display:flex!important;align-items:center;gap:4px;font-size:13px;margin:0;cursor:pointer;color:#ccc;}',
        '.checkbox_label input{margin:0;}',
        '.sync-controls{display:flex;gap:8px;align-items:center;margin:8px 0;}',
        '.sync-status-label{margin-left:12px;font-size:13px;color:#aaa;}',
        '.sync-log{background:#1a1a1a;border:1px solid #333;border-radius:4px;padding:8px;max-height:200px;overflow-y:auto;font-size:12px;font-family:monospace;}',
        '.sync-log-entry{padding:2px 0;border-bottom:1px solid #222;line-height:1.5;}',
        '.sync-log-entry:last-child{border-bottom:none;}',
        '.sync-log-error{color:#d9534f;} .sync-log-success{color:#5cb85c;}',
        '.sync-log-warning{color:#f0ad4e;} .sync-log-info{color:#aaa;}',
        '#sync-test-result{margin-left:8px;font-size:13px;}',
        '.sync-radio-group{display:flex;flex-direction:column;gap:4px;}',
        '.sync-radio-group .checkbox_label{font-size:13px;color:#ccc;cursor:pointer;}',
        // Conflict panel
        '.sync-conflict-panel{max-height:60vh;overflow-y:auto;}',
        '.sync-conflict-file{display:flex;align-items:center;gap:8px;padding:8px;border-bottom:1px solid #333;}',
        '.sync-conflict-file:last-child{border-bottom:none;}',
        '.sync-conflict-name{flex:1;color:#ccc;font-size:13px;word-break:break-all;}',
        '.sync-conflict-btns{display:flex;gap:4px;flex-shrink:0;}',
        '.sync-conflict-editor{width:100%;min-height:300px;background:#1a1a1a;color:#ccc;border:1px solid #555;font-family:monospace;font-size:12px;padding:8px;resize:vertical;}',
        '.sync-conflict-global{display:flex;gap:8px;margin-top:12px;padding-top:12px;border-top:1px solid #555;}',
        // Dialog
        '.dialog-modal{position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.6);display:flex;align-items:center;justify-content:center;z-index:99999;}',
        '.dialog-content{background:#2a2a2a;border:1px solid #555;border-radius:8px;padding:20px;max-width:400px;width:90%;}',
        '.dialog-content h4{margin:0 0 8px 0;color:#fff;}',
        '.dialog-content p{margin:0 0 16px 0;color:#ccc;}',
        '.dialog-buttons{display:flex;gap:8px;justify-content:flex-end;}',
        '</style>',
    ].join('');
}

function bindSettingsEvents() {
    const $panel = $('#github-data-sync-settings');
    if (!$panel.length) return;

    // Load config into form
    loadConfig().then(function (cfg) {
        $('#sync-github-repo').val(cfg.githubRepo || '');
        $('#sync-branch').val(cfg.branch || 'main');
        $('#sync-github-token').val('');
        $('#sync-github-token').attr('placeholder', cfg.githubToken ? '(已保存，留空则不修改)' : 'ghp_...');
        var ds = cfg.dataSelection || {};
        $('#sync-data-characters').prop('checked', ds.characters !== false);
        $('#sync-data-chats').prop('checked', ds.chats !== false);
        $('#sync-data-worlds').prop('checked', ds.worlds !== false);
        $('#sync-data-groups').prop('checked', ds.groups !== false);
        $('#sync-data-settings').prop('checked', ds.settings !== false);
        $('#sync-data-presets').prop('checked', ds.presets !== false);
        $('#sync-data-personas').prop('checked', ds.personas !== false);
        $('#sync-data-backgrounds').prop('checked', ds.backgrounds === true);
        $('#sync-data-themes').prop('checked', ds.themes === true);
        $('#sync-data-extensions').prop('checked', ds.extensions !== false);
        var ap = cfg.autoPush || {};
        $('#sync-autopush-enabled').prop('checked', ap.enabled === true);
        $('#sync-autopush-interval').val(ap.intervalMinutes || 30);
        var ab = cfg.autoBackup || {};
        $('#sync-autobackup-enabled').prop('checked', ab.enabled !== false);
        $('#sync-autobackup-max').val(ab.maxBackups || 5);
        $('#sync-pull-confirmation').prop('checked', cfg.pullConfirmation !== false);
        $('input[name="sync-pull-mode"][value="' + (cfg.pullMode || 'local-first') + '"]').prop('checked', true);
        refreshAllUI();
        loadBackupList();
    });

    // Debounced save
    var saveTimeout;
    function collectAndSave() {
        saveConfig({
            githubRepo: $('#sync-github-repo').val().trim(),
            branch: $('#sync-branch').val().trim() || 'main',
            githubToken: $('#sync-github-token').val().trim(),
            dataSelection: {
                characters: $('#sync-data-characters').is(':checked'),
                chats: $('#sync-data-chats').is(':checked'),
                worlds: $('#sync-data-worlds').is(':checked'),
                groups: $('#sync-data-groups').is(':checked'),
                settings: $('#sync-data-settings').is(':checked'),
                presets: $('#sync-data-presets').is(':checked'),
                personas: $('#sync-data-personas').is(':checked'),
                backgrounds: $('#sync-data-backgrounds').is(':checked'),
                themes: $('#sync-data-themes').is(':checked'),
                extensions: $('#sync-data-extensions').is(':checked'),
            },
            autoPush: {
                enabled: $('#sync-autopush-enabled').is(':checked'),
                intervalMinutes: parseInt($('#sync-autopush-interval').val()) || 30,
            },
            autoBackup: {
                enabled: $('#sync-autobackup-enabled').is(':checked'),
                maxBackups: parseInt($('#sync-autobackup-max').val()) || 5,
            },
            pullConfirmation: $('#sync-pull-confirmation').is(':checked'),
            pullMode: $('input[name="sync-pull-mode"]:checked').val() || 'local-first',
        });
    }
    $panel.on('change input', 'input', function () {
        clearTimeout(saveTimeout);
        saveTimeout = setTimeout(collectAndSave, 500);
    });

    // Toggle token
    $('#sync-toggle-token').on('click', function () {
        var $t = $('#sync-github-token');
        var show = $t.attr('type') === 'password';
        $t.attr('type', show ? 'text' : 'password');
        $('#sync-toggle-token .fa').toggleClass('fa-eye fa-eye-slash');
    });

    // Test connection
    $('#sync-test-connection').on('click', async function () {
        await saveConfig({
            githubRepo: $('#sync-github-repo').val().trim(),
            branch: $('#sync-branch').val().trim() || 'main',
            githubToken: $('#sync-github-token').val().trim(),
        });
        var $r = $('#sync-test-result');
        $r.text('测试中...').css('color', '#f0ad4e');
        try {
            var data = await apiCall('GET', '/validate');
            if (data.valid) {
                $r.text(data.message || '连接成功').css('color', '#5cb85c');
            } else {
                $r.text('失败: ' + (data.errors || ['未知错误']).join(', ')).css('color', '#d9534f');
            }
        } catch (err) {
            $r.text('错误: ' + err.message).css('color', '#d9534f');
        }
    });

    // Manual buttons
    $('#sync-push-now').on('click', doPush);
    $('#sync-pull-now').on('click', doPull);

    // Backup
    $('#sync-backup-now').on('click', async function () {
        try {
            toastr.info('正在创建备份...', 'GitHub Sync');
            var data = await apiCall('POST', '/backup/create');
            if (data.message) { toastr.info(data.message, 'GitHub Sync'); }
            else { toastr.success('备份已创建: ' + (data.sizeFormatted || ''), 'GitHub Sync'); }
            loadBackupList();
        } catch (err) { toastr.error('备份失败: ' + err.message, 'GitHub Sync'); }
    });
    $('#sync-backup-list').on('click', '.sync-backup-restore', async function () {
        var id = $(this).data('id');
        var confirmed = await showConfirmDialog('确认恢复备份？', '将用备份（' + id.replace(/T/g, ' ').substring(0, 16) + '）覆盖当前数据。是否继续？');
        if (!confirmed) return;
        try {
            toastr.info('正在恢复备份...', 'GitHub Sync');
            var data = await apiCall('POST', '/backup/restore', { backupId: id });
            toastr.success('已恢复: ' + data.restored.join(', '), 'GitHub Sync');
            refreshAllUI();
        } catch (err) { toastr.error('恢复失败: ' + err.message, 'GitHub Sync'); }
    });
    $('#sync-backup-list').on('click', '.sync-backup-delete', async function () {
        var id = $(this).data('id');
        try {
            await apiCall('DELETE', '/backup/' + encodeURIComponent(id));
            toastr.info('备份已删除。', 'GitHub Sync');
            loadBackupList();
        } catch (err) { toastr.error('删除失败: ' + err.message, 'GitHub Sync'); }
    });
    $('#sync-backup-refresh').on('click', function () {
        loadBackupList();
    });

    // Extension scan
    $('#sync-ext-scan').on('click', async function () {
        try {
            toastr.info('正在扫描扩展...', 'GitHub Sync');
            var data = await apiCall('GET', '/extensions');
            if (!data.list || data.list.length === 0) {
                $('#sync-ext-list').val('未发现已安装的第三方扩展。');
                toastr.info('未发现已安装的第三方扩展。', 'GitHub Sync');
                return;
            }
            var text = data.list.map(function (e) {
                return '- ' + e.name + ': ' + e.url;
            }).join('\n');
            $('#sync-ext-list').val(text);
            toastr.success('发现 ' + data.list.length + ' 个扩展，列表已保存到云端。', 'GitHub Sync');
        } catch (err) {
            toastr.error('扫描失败: ' + err.message, 'GitHub Sync');
        }
    });

    // Dynamic polling: 2s during sync, 30s when idle
    (function dynamicPoll() {
        apiCall('GET', '/status').then(function (data) {
            updateStatusUI(data);
            var delay = data.syncInProgress ? 2000 : 30000;
            setTimeout(dynamicPoll, delay);
        }).catch(function () {
            setTimeout(dynamicPoll, 30000);
        });
    })();
}

// ===================== MAIN INIT (DOM ready) =====================

$(function () {
    // Add settings panel
    try {
        var $target = $('#extensions_settings');
        if (!$target.length) $target = $('#extensions_settings_container');
        if (!$target.length) $target = $('body');
        $target.append(buildSettingsHtml());
        bindSettingsEvents();
    } catch (err) {
        console.error('[GitHub-Data-Sync] Settings panel init failed:', err);
    }

    // Register slash commands via dynamic import (may not exist in all ST versions)
    Promise.all([
        import('../../../slash-commands/SlashCommandParser.js'),
        import('../../../slash-commands/SlashCommand.js'),
    ]).then(function (modules) {
        var SlashCommandParser = modules[0].SlashCommandParser;
        var SlashCommand = modules[1].SlashCommand;
        SlashCommandParser.addCommandObject(SlashCommand.fromProps({
            name: 'sync-push', callback: doPush,
            helpString: '将 SillyTavern 数据推送到配置的 GitHub 仓库。',
        }));
        SlashCommandParser.addCommandObject(SlashCommand.fromProps({
            name: 'sync-pull', callback: doPull,
            helpString: '从 GitHub 仓库拉取最新数据并恢复到本地。',
        }));
        SlashCommandParser.addCommandObject(SlashCommand.fromProps({
            name: 'sync-status', callback: doStatus,
            helpString: '显示当前同步状态和最近的操作日志。',
        }));
        SlashCommandParser.addCommandObject(SlashCommand.fromProps({
            name: 'sync-backups', callback: doBackups,
            helpString: '列出所有本地备份。',
        }));
        SlashCommandParser.addCommandObject(SlashCommand.fromProps({
            name: 'sync-restore', callback: doRestore,
            helpString: '从备份恢复数据。用法: /sync-restore <序号>（先用 /sync-backups 查看列表）。',
            unnamedArgument: { name: 'N', type: 'integer', isRequired: true },
        }));
        console.log('[GitHub-Data-Sync] 斜杠命令已注册: /sync-push /sync-pull /sync-status /sync-backups /sync-restore');
    }).catch(function (err) {
        console.warn('[GitHub-Data-Sync] 斜杠命令注册失败（不影响核心功能）:', err.message);
    });

    console.log('[GitHub-Data-Sync] 初始化完成。');
});