#!/usr/bin/env node
/**
 * github-data-sync 回归测试
 *
 * 运行: npm test   或   node test/run.js
 *
 * 特点：
 * - 不需要网络（不访问 GitHub）
 * - 不需要 SillyTavern 运行环境
 * - 不触碰真实用户数据（全部在 os.tmpdir() 下造临时目录）
 */
'use strict';

const assert = require('assert');
const os = require('os');
const path = require('path');
const fs = require('fs-extra');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');

const backup = require(path.join(ROOT, 'lib', 'backup'));
const sc = require(path.join(ROOT, 'lib', 'sync-config'));
const gitOps = require(path.join(ROOT, 'lib', 'git-ops'));
const secrets = require(path.join(ROOT, 'lib', 'secrets'));
const dataLayout = require(path.join(ROOT, 'lib', 'data-layout'));

// index.js 会连带加载 simple-git；依赖未安装时跳过依赖它的用例
let idx = null;
try {
    idx = require(path.join(ROOT, 'index.js'));
} catch (err) {
    console.warn(`[warn] 无法加载 index.js，相关用例将跳过: ${err.message}`);
}

const tests = [];
function test(name, fn) {
    tests.push({ name, fn });
}

const cleanupDirs = [];
function tmpDir(tag) {
    const d = path.join(os.tmpdir(), `stgs-test-${tag}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
    fs.ensureDirSync(d);
    cleanupDirs.push(d);
    return d;
}

function cleanup() {
    for (const d of cleanupDirs) {
        try { fs.removeSync(d); } catch { /* 清理失败不影响测试结论 */ }
    }
}

/** 按 dataLayout 给出的真实路径造数据，避免在测试里硬编码目录结构 */
function seedData(root, categories) {
    for (const cat of categories) {
        const p = dataLayout.getSourcePath(cat, root);
        fs.ensureDirSync(path.dirname(p));
        if (dataLayout.getType(cat) === 'directory') {
            fs.ensureDirSync(p);
            fs.writeFileSync(path.join(p, 'sample.txt'), `content of ${cat}`);
        } else {
            fs.writeFileSync(p, JSON.stringify({ seeded: cat }, null, 2));
        }
    }
}

function makeConfig(categories, autoBackupExtra) {
    const dataSelection = {};
    for (const c of dataLayout.CATEGORIES) dataSelection[c] = categories.includes(c);
    return sc.mergeWithDefaults({
        githubRepo: 'owner/repo',
        branch: 'main',
        autoBackup: { enabled: true, maxBackups: 5, ...(autoBackupExtra || {}) },
        dataSelection,
    });
}

function withEnvCleared(fn) {
    const savedSync = process.env.ST_GITHUB_SYNC_TOKEN;
    const savedGh = process.env.GITHUB_TOKEN;
    delete process.env.ST_GITHUB_SYNC_TOKEN;
    delete process.env.GITHUB_TOKEN;
    try {
        return fn();
    } finally {
        if (savedSync === undefined) delete process.env.ST_GITHUB_SYNC_TOKEN;
        else process.env.ST_GITHUB_SYNC_TOKEN = savedSync;
        if (savedGh === undefined) delete process.env.GITHUB_TOKEN;
        else process.env.GITHUB_TOKEN = savedGh;
    }
}

// ===================== 备份路径安全 =====================

test('resolveBackupDir 接受合法的秒级时间戳 ID', () => {
    const root = tmpDir('bk-ok');
    const got = backup.resolveBackupDir('2026-09-12T07-39-59', root);
    assert.strictEqual(
        got,
        path.join(path.resolve(root), 'backups', 'github-sync', '2026-09-12T07-39-59')
    );
});

test('resolveBackupDir 拒绝路径穿越与畸形 ID', () => {
    const root = tmpDir('bk-bad');
    const bad = [
        '../..',
        '..',
        'a/b',
        '',
        '2026-09-12T07:39:59',      // 冒号未替换
        '2026-9-12T07-39-59',       // 月份未补零
        '2026-09-12T07-39-59/',     // 结尾斜杠
        ' 2026-09-12T07-39-59',     // 前导空格
        '2026-09-12T07-39-59/../../x',
    ];
    for (const id of bad) {
        assert.throws(() => backup.resolveBackupDir(id, root), `应拒绝: ${JSON.stringify(id)}`);
    }
});

// ===================== 备份语义 =====================

test('createBackup：功能关闭时返回 disabled（而非静默 null）', async () => {
    const root = tmpDir('bk-disabled');
    const r = await backup.createBackup(
        sc.mergeWithDefaults({ autoBackup: { enabled: false }, dataSelection: { themes: true } }),
        root
    );
    assert.deepStrictEqual(r, { created: false, reason: 'disabled', categories: [], size: 0 });
});

test('createBackup：无数据时返回 no-data', async () => {
    const root = tmpDir('bk-nodata');
    const r = await backup.createBackup(makeConfig(['themes']), root);
    assert.strictEqual(r.created, false);
    assert.strictEqual(r.reason, 'no-data');
});

test('createBackup：正常创建并写入指纹元数据', async () => {
    const root = tmpDir('bk-create');
    seedData(root, ['themes']);
    const r = await backup.createBackup(makeConfig(['themes']), root);
    assert.strictEqual(r.created, true);
    assert.ok(r.fingerprint, '应返回内容指纹');
    assert.deepStrictEqual(r.categories, ['themes']);
    assert.ok(fs.existsSync(path.join(r.path, backup.META_FILE_NAME)), '应写入 meta.json');
});

test('createBackup：内容未变时跳过重复备份', async () => {
    const root = tmpDir('bk-dedup');
    seedData(root, ['themes']);

    const first = await backup.createBackup(makeConfig(['themes']), root);
    assert.strictEqual(first.created, true);

    const second = await backup.createBackup(makeConfig(['themes']), root);
    assert.strictEqual(second.created, false, '第二次应跳过');
    assert.strictEqual(second.reason, 'unchanged');
});

test('createBackup：内容变化后重新备份', async () => {
    const root = tmpDir('bk-change');
    seedData(root, ['themes']);
    await backup.createBackup(makeConfig(['themes']), root);

    const file = path.join(dataLayout.getSourcePath('themes', root), 'sample.txt');
    fs.writeFileSync(file, 'changed content with a different size');
    const now = new Date();
    fs.utimesSync(file, now, now);

    const r = await backup.createBackup(makeConfig(['themes']), root);
    assert.strictEqual(r.created, true, '内容变化后应重新创建');
});

test('listBackups 不把 meta.json 当成一个类别', async () => {
    const root = tmpDir('bk-list');
    seedData(root, ['themes']);
    await backup.createBackup(makeConfig(['themes']), root);

    const list = await backup.listBackups(root);
    assert.strictEqual(list.length, 1);
    assert.deepStrictEqual(list[0].categories, ['themes']);
});

// ===================== 备份容量治理 =====================

test('cleanupOldBackups 按数量裁剪，删除最旧的', async () => {
    const root = tmpDir('bk-count');
    const backupRoot = path.join(root, 'backups', 'github-sync');
    for (const id of ['2026-01-01T00-00-01', '2026-01-01T00-00-02', '2026-01-01T00-00-03']) {
        fs.ensureDirSync(path.join(backupRoot, id));
        fs.writeFileSync(path.join(backupRoot, id, 'f.txt'), 'x');
    }

    const r = await backup.cleanupOldBackups(backupRoot, 2, 0);
    assert.strictEqual(r.removed.length, 1);
    assert.strictEqual(r.removed[0], '2026-01-01T00-00-01');
    assert.ok(!fs.existsSync(path.join(backupRoot, '2026-01-01T00-00-01')));
});

test('cleanupOldBackups 按总体积裁剪，且至少保留一份', async () => {
    const root = tmpDir('bk-size');
    const backupRoot = path.join(root, 'backups', 'github-sync');
    const oneMB = Buffer.alloc(1024 * 1024, 1);

    for (const id of ['2026-01-01T00-00-01', '2026-01-01T00-00-02', '2026-01-01T00-00-03']) {
        fs.ensureDirSync(path.join(backupRoot, id));
        fs.writeFileSync(path.join(backupRoot, id, 'big.bin'), oneMB);
    }

    // 3 x 1MB，上限 2MB -> 删掉 1 份
    const r = await backup.cleanupOldBackups(backupRoot, 10, 2);
    assert.strictEqual(r.removed.length, 1);
    assert.strictEqual(r.totalSize, 2 * 1024 * 1024);

    // 上限远小于单份体积时，绝不能把备份删空
    await backup.cleanupOldBackups(backupRoot, 10, 0.1);
    assert.strictEqual(fs.readdirSync(backupRoot).length, 1, '必须至少保留一份');
});

// ===================== Token 解析与存储 =====================

test('resolveGithubToken 优先级：环境变量 > 密钥文件 > 旧字段', () => {
    withEnvCleared(() => {
        const tf = path.join(tmpDir('tok'), 'x.token');
        secrets.writeTokenToFile(tf, 'ghp_fromfile');

        assert.strictEqual(sc.resolveGithubToken({ tokenFile: tf }), 'ghp_fromfile');
        assert.strictEqual(sc.resolveGithubToken({ githubToken: 'ghp_legacy' }), 'ghp_legacy');
        assert.strictEqual(
            sc.resolveGithubToken({ tokenFile: tf, githubToken: 'ghp_legacy' }),
            'ghp_fromfile',
            '密钥文件应优先于旧字段'
        );

        process.env.ST_GITHUB_SYNC_TOKEN = 'ghp_fromenv';
        assert.strictEqual(
            sc.resolveGithubToken({ tokenFile: tf, githubToken: 'ghp_legacy' }),
            'ghp_fromenv',
            '环境变量优先级最高'
        );
    });
});

test('密钥文件权限为 0600', () => {
    const tf = path.join(tmpDir('perm'), 'secret.token');
    secrets.writeTokenToFile(tf, 'ghp_x');
    const mode = fs.statSync(tf).mode & 0o777;
    assert.strictEqual(mode, 0o600, `期望 0600，实际 ${mode.toString(8)}`);
});

test('buildGitEnv：保留 PATH、剔除 simple-git 黑名单键、注入 askpass', () => {
    withEnvCleared(() => {
        const tf = path.join(tmpDir('env'), 'e.token');
        secrets.writeTokenToFile(tf, 'ghp_envtest');

        const env = gitOps.buildGitEnv({ tokenFile: tf });
        assert.ok('PATH' in env, 'PATH 必须保留，否则 git 无法启动');
        assert.ok(!('PREFIX' in env), 'PREFIX 必须剔除（Termux 上会触发 simple-git 拦截）');
        assert.ok(!('GIT_PAGER' in env), 'GIT_PAGER 在黑名单内，必须剔除');
        assert.strictEqual(env.GIT_TERMINAL_PROMPT, '0');
        assert.ok(env.GIT_ASKPASS && env.GIT_ASKPASS.endsWith('askpass.sh'));
        assert.strictEqual(env.ST_GITHUB_SYNC_TOKEN_FILE, tf);
        assert.strictEqual(env.GIT_CONFIG_COUNT, undefined, '不应再依赖 GIT_CONFIG_COUNT');
    });
});

test('buildGitEnv：无 token 时不注入 askpass', () => {
    withEnvCleared(() => {
        const env = gitOps.buildGitEnv({ githubToken: '' });
        assert.strictEqual(env.GIT_ASKPASS, undefined);
    });
});

test('askpass 助手：用户名固定，密码取文件、可回退环境变量', () => {
    const tf = path.join(tmpDir('ap'), 'a.token');
    secrets.writeTokenToFile(tf, 'ghp_askpassfile');
    const script = secrets.ensureAskpassSync();

    assert.strictEqual(
        execFileSync(script, ['Username for https://github.com'], { env: { ST_GITHUB_SYNC_TOKEN_FILE: tf } })
            .toString().trim(),
        'x-access-token'
    );
    assert.strictEqual(
        execFileSync(script, ['Password for https://github.com'], { env: { ST_GITHUB_SYNC_TOKEN_FILE: tf } })
            .toString().trim(),
        'ghp_askpassfile'
    );
    assert.strictEqual(
        execFileSync(script, ['Password for https://github.com'], { env: { ST_GITHUB_SYNC_TOKEN: 'ghp_askpassenv' } })
            .toString().trim(),
        'ghp_askpassenv'
    );
});

test('buildRemoteUrl 不含任何凭据', () => {
    assert.strictEqual(
        gitOps.buildRemoteUrl({ githubRepo: 'owner/repo' }),
        'https://github.com/owner/repo.git'
    );
});

// ===================== 网络健壮性 =====================

test('isTransientGitError：网络类可重试，鉴权类不可重试', () => {
    assert.strictEqual(
        gitOps.isTransientGitError(new Error('fatal: unable to access: Could not resolve host: github.com')),
        true
    );
    assert.strictEqual(gitOps.isTransientGitError(new Error('Connection timed out')), true);
    assert.strictEqual(gitOps.isTransientGitError(new Error('remote: 503 Service Unavailable')), true);

    assert.strictEqual(
        gitOps.isTransientGitError(new Error('fatal: Authentication failed for https://github.com/x/y.git')),
        false
    );
    assert.strictEqual(gitOps.isTransientGitError(new Error('remote: Repository not found.')), false);
    assert.strictEqual(gitOps.isTransientGitError(new Error('Use of "PREFIX" is not permitted')), false);
});

test('withGitRetry：瞬时错误重试后成功，鉴权错误立即抛出', async () => {
    let attempts = 0;
    const result = await gitOps.withGitRetry(async () => {
        attempts++;
        if (attempts < 3) throw new Error('Connection timed out');
        return 'ok';
    }, '测试');
    assert.strictEqual(result, 'ok');
    assert.strictEqual(attempts, 3, '应重试到第 3 次');

    let authAttempts = 0;
    await assert.rejects(
        () => gitOps.withGitRetry(async () => {
            authAttempts++;
            throw new Error('fatal: Authentication failed');
        }, '测试'),
        /Authentication failed/
    );
    assert.strictEqual(authAttempts, 1, '鉴权错误不应重试');
});

test('git 操作设有超时上限，避免网络挂起时永久卡死', () => {
    assert.ok(Number.isFinite(gitOps.GIT_TIMEOUT_MS), 'GIT_TIMEOUT_MS 应为数字');
    assert.ok(gitOps.GIT_TIMEOUT_MS > 0 && gitOps.GIT_TIMEOUT_MS <= 600000);
});

// ===================== 配置迁移 =====================

test('migrateLegacyToken：明文迁移到 0600 文件并清空配置字段', () => {
    if (!idx) return;
    const dir = tmpDir('migrate');
    const cfgPath = path.join(dir, 'github-data-sync-config.json');
    const tf = path.join(dir, 'm.token');

    const saved = { githubRepo: 'a/b', branch: 'main', githubToken: 'ghp_plaintext', tokenFile: tf };
    fs.writeJsonSync(cfgPath, saved, { spaces: 4 });

    idx.migrateLegacyToken(saved, 'tester', cfgPath);

    assert.strictEqual(saved.githubToken, '', '内存中应清空');
    assert.strictEqual(secrets.readTokenFromFile(tf), 'ghp_plaintext', '应落到密钥文件');
    assert.strictEqual(fs.readJsonSync(cfgPath).githubToken, '', '磁盘上应清空');
    assert.strictEqual(fs.statSync(tf).mode & 0o777, 0o600, '密钥文件应为 0600');
});

test('migrateLegacyToken：密钥文件已存在时不覆盖', () => {
    if (!idx) return;
    const dir = tmpDir('migrate2');
    const cfgPath = path.join(dir, 'github-data-sync-config.json');
    const tf = path.join(dir, 'm2.token');

    secrets.writeTokenToFile(tf, 'ghp_existing');
    const saved = { githubRepo: 'a/b', branch: 'main', githubToken: 'ghp_shouldnotwin', tokenFile: tf };
    fs.writeJsonSync(cfgPath, saved, { spaces: 4 });

    idx.migrateLegacyToken(saved, 'tester', cfgPath);

    assert.strictEqual(secrets.readTokenFromFile(tf), 'ghp_existing', '不应被覆盖');
    assert.strictEqual(saved.githubToken, '');
});

test('createUserContext：零操作完成迁移，且 token 可正常解析', () => {
    if (!idx) return;
    const root = tmpDir('ctx');
    const tf = path.join(root, 'ctx.token');
    fs.writeJsonSync(
        path.join(root, 'github-data-sync-config.json'),
        { githubRepo: 'a/b', branch: 'main', githubToken: 'ghp_ctxmigrate', tokenFile: tf },
        { spaces: 4 }
    );

    const ctx = idx.createUserContext('ctx-test-user', root);
    assert.strictEqual(ctx.config.githubToken, '', '配置中不应再有明文');
    assert.strictEqual(sc.resolveGithubToken(ctx.config), 'ghp_ctxmigrate', '应能从密钥文件解析');
    assert.ok(Array.isArray(ctx.syncLog), '应有日志数组');
    assert.strictEqual(typeof ctx.logFilePath, 'string', '应记录日志文件路径');
});

// ===================== 运行 =====================

(async () => {
    let passed = 0;
    let failed = 0;

    for (const t of tests) {
        try {
            await t.fn();
            passed++;
            console.log(`  ok    ${t.name}`);
        } catch (err) {
            failed++;
            console.error(`  FAIL  ${t.name}`);
            console.error(`        ${err.message}`);
        }
    }

    cleanup();

    console.log('');
    console.log(`通过 ${passed} / ${passed + failed}`);
    if (failed > 0) {
        console.error(`失败 ${failed}`);
        process.exit(1);
    }
    process.exit(0);
})();
