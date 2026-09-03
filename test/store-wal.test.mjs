// WAL 收口。
//
// 起因是线上真事:`app.db` 主库 **4096 字节**,全部数据活在 **4MB 的 WAL** 里。
//
// 根因不是「checkpoint 没缩文件」,比那个更钝 —— **第一次 checkpoint 从来没跑过**:
// SQLite 的 wal_autocheckpoint 默认阈值是 **1000 页**,不到就一页都不往主库搬,
// 连建表的那几页都不搬。线上那个 WAL 是 4107672 字节 ≈ 997 帧(每帧 4096+24),
// 差 3 帧没过线。于是 app.db 一直是一个只有文件头的空文件。
//
// ★ 危险的不是丢数据(整库完好),是**备份**:
//   只拷 app.db 的人,拷到的是一个 4096 字节的空壳,而且它能作为一个合法的空库打开 ——
//   不报错、不告警,恢复的那天才发现里面什么都没有。
//   这正是长期无人值守时最咬人的形态:照着文档备份,拿到的是一个空文件。
//
// 三道闸:①开库时收一次(让升级本身自愈)②每 N 次写收一次(长驻进程不能只靠退出)
//        ③退出时收一次(exit 钩子)
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const STORE_URL = pathToFileURL(path.join(REPO, 'lib', 'store-sqlite.js')).href;
const sz = (f) => { try { return fs.statSync(f).size; } catch { return 0; } };
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ccc-wal-'));

function run(code, env = {}) {
  const r = spawn(process.execPath, ['--input-type=module', '-e', code], {
    cwd: REPO, env: { ...process.env, ...env },
  });
  return new Promise((res) => {
    let out = ''; let err = '';
    r.stdout.on('data', (d) => { out += d; });
    r.stderr.on('data', (d) => { err += d; });
    r.on('close', (code2) => res({ out, err, code: code2 }));
  });
}

// 造出「出问题的那台此刻的样子」:写了一堆数据,但进程没有正常关库就没了。
// ★ 关键是 **不调 db.close()** —— 调了 SQLite 自己会收口,就复现不出来了。
const MAKE_SHELL = (dbPath, rows) => `
  import { createRequire } from 'node:module';
  const { DatabaseSync } = createRequire(${JSON.stringify(REPO + '/x.js')})('node:sqlite');
  const db = new DatabaseSync(${JSON.stringify(dbPath)});
  db.exec('PRAGMA journal_mode=WAL');
  db.exec('CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT)');
  const ins = db.prepare('INSERT INTO kv(key,value) VALUES(?,?)');
  for (let i = 0; i < ${rows}; i++) ins.run('k'+i, 'v'.repeat(200));
  process.exit(0);   // ← 故意不 close:模拟服务被 kill / 长驻几周从没退出
`;

test('复现:不到 1000 页阈值,主库连表结构都拿不到(真实部署上就是这个样子)', async () => {
  const dir = tmp(); const db = path.join(dir, 'app.db');
  await run(MAKE_SHELL(db, 300));  // 300 行 ≈ 634 帧,稳在 1000 页阈值以下(500 行就过线了)
  assert.equal(sz(db), 4096, '主库应该还是只有文件头的空壳');
  assert.ok(sz(db + '-wal') > 100 * 1024, `WAL 里应该有货,实际 ${sz(db + '-wal')}`);

  // ★ 空壳能作为合法空库打开 —— 这就是「备份了个寂寞还不报错」的机制。
  const shell = path.join(dir, 'onlymain.db');
  fs.copyFileSync(db, shell);              // 只拷主库,模拟只备份 app.db
  const r = await run(`
    import { createRequire } from 'node:module';
    const { DatabaseSync } = createRequire(${JSON.stringify(REPO + '/x.js')})('node:sqlite');
    const db = new DatabaseSync(${JSON.stringify(shell)});
    const t = db.prepare("SELECT count(*) c FROM sqlite_master").get();
    console.log('TABLES=' + t.c);
  `);
  assert.match(r.out, /TABLES=0/, '只拷主库 → 打开成功但一张表都没有,而且不报错');
  fs.rmSync(dir, { recursive: true, force: true });
});

// 造出「真 schema 的库,但数据卡在 WAL 里」。
// ★ 第一版这里用裸 sqlite 建了张 kv 表就完事,结果 openStoreSync 一开就
//   `no such table: messages` —— 夹具太假,假到根本走不到被测的那一步。
//   要复现的是「我们自己的库躺成了空壳」,那就得用我们自己的库去造。
const MAKE_REAL_SHELL = (dbPath, rows) => `
  const { openStoreSync } = await import(${JSON.stringify(STORE_URL)});
  const fs = await import('node:fs');
  const s = openStoreSync(${JSON.stringify(dbPath)});
  s._checkpointEvery = Infinity;        // ← 关掉新加的定期收口,才造得出「旧代码的样子」
  for (let i = 0; i < ${rows}; i++) {
    s.putMessage({ id: i + 1, scope: 'chat', sender: 'x', role: 'user',
      content: 'y'.repeat(400), created_at: '2026-01-01T00:00:00.000Z' });
  }
  const sz = (f) => { try { return fs.statSync(f).size; } catch { return 0; } };
  console.log('MAIN=' + sz(${JSON.stringify(dbPath)}));
  console.log('WAL=' + sz(${JSON.stringify(dbPath)} + '-wal'));
  process.exit(0);                      // 不 close:模拟被 kill / 几周没退出
`;

test('自愈:新代码开库那一下就把 WAL 折回主库(升级即修,不用手跑命令)', async () => {
  const dir = tmp(); const db = path.join(dir, 'app.db');
  const made = await run(MAKE_REAL_SHELL(db, 300));
  const mainBefore = Number(/MAIN=(\d+)/.exec(made.out)?.[1] ?? -1);
  const walBefore = Number(/WAL=(\d+)/.exec(made.out)?.[1] ?? -1);
  assert.ok(walBefore > 100 * 1024, `前置:WAL 里得先有货,实际 ${walBefore}\n${made.err}`);

  const r = await run(`
    const { openStoreSync } = await import(${JSON.stringify(STORE_URL)});
    const s = openStoreSync(${JSON.stringify(db)});
    console.log('ROWS=' + s.loadAll().chat_messages.length);
    process.exit(0);
  `);
  assert.match(r.out, /ROWS=300/, `数据得一条不少地读回来\n${r.out}\n${r.err}`);
  assert.ok(sz(db) > mainBefore, `开库后主库应该变大(${mainBefore} → ${sz(db)})`);
  assert.equal(sz(db + '-wal'), 0, `WAL 应该被 TRUNCATE 到 0,实际 ${sz(db + '-wal')}`);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('长驻:不到 1000 页阈值也照样收口 —— 这正是线上那台的处境', async () => {
  const dir = tmp(); const db = path.join(dir, 'app.db');
  // ★ 差分点:250 次写 ≈ 500 多帧,**永远够不到 SQLite 的 1000 页自动阈值**。
  //   没有 _tick 的话主库会一直停在 4096;有了才会长大。不用魔法数字,是 0/非 0 的差别。
  const r = await run(`
    const { openStoreSync } = await import(${JSON.stringify(STORE_URL)});
    const fs = await import('node:fs');
    const s = openStoreSync(${JSON.stringify(db)});
    const sz = (f) => { try { return fs.statSync(f).size; } catch { return 0; } };
    console.log('BEFORE=' + sz(${JSON.stringify(db)}));   // ← 开库收口之后、写之前
    for (let i = 0; i < 250; i++) {
      s.putMessage({ id: i + 1, scope: 'chat', sender: 'x', role: 'user',
        content: 'y'.repeat(400), created_at: '2026-01-01T00:00:00.000Z' });
    }
    console.log('AFTER=' + sz(${JSON.stringify(db)}));
    process.exit(0);   // 同样不 close —— 证明是「跑着的时候」收的,不是退出时收的
  `);
  const before = Number(/BEFORE=(\d+)/.exec(r.out)?.[1] ?? -1);
  const after = Number(/AFTER=(\d+)/.exec(r.out)?.[1] ?? -1);
  assert.ok(before > 0, r.err);
  // ★ 必须比「写之前」大,不能比 4096 大。
  //   第一版写的是 `after > 4096` —— 变异测试当场揭穿:把 _tick 掏空它照样绿,
  //   因为开库时那次 checkpoint 已经把表结构折进主库了,4096 这条线早就被别人跨过。
  //   断言要卡在**这个守卫独有的那段差值**上,否则它只是在给别人的守卫搭便车。
  assert.ok(after > before,
    `低流量(250 次写,够不到 1000 页)下主库必须在跑的过程中长大:${before} → ${after}(_tick 没生效)\n${r.err}`);
});

test('生产路径:写被 tx 包着时,收口也要真的发生', async () => {
  const dir = tmp(); const db = path.join(dir, 'app.db');
  // ★ 这条是补上来的,补的正是一个差点漏网的洞。
  //   上面那条「长驻」直接调 s.putMessage(),而**真实的写全都包在 tx 里**
  //   (state.js 的 saveStoreSqlite 每次写都开事务,顺带更新 counters)。
  //   偏偏 `PRAGMA wal_checkpoint` 在事务里**不报错、也不干活** ——
  //   静默返回 {busy:0, log:0, checkpointed:0}。于是 _tick 在生产路径上是空炮,
  //   还把 _writes 清零,导致永远收不成。测试测的层,得是真正在跑的那层。
  const r = await run(`
    const { openStoreSync } = await import(${JSON.stringify(STORE_URL)});
    const fs = await import('node:fs');
    const s = openStoreSync(${JSON.stringify(db)});
    const sz = (f) => { try { return fs.statSync(f).size; } catch { return 0; } };
    let peak = 0;
    for (let i = 0; i < 250; i++) {
      s.tx(() => {
        s.putMessage({ id: i + 1, scope: 'chat', sender: 'x', role: 'user',
          content: 'y'.repeat(400), created_at: '2026-01-01T00:00:00.000Z' });
        s.putKv('counters', { message: i + 2 });
      });
      const w = sz(${JSON.stringify(db)} + '-wal');
      if (w > peak) peak = w;
    }
    console.log('PEAK=' + peak);
    process.exit(0);
  `);
  const peak = Number(/PEAK=(\d+)/.exec(r.out)?.[1] ?? -1);
  assert.ok(peak > 0, r.err);
  // ★ 判据卡在 2MB:SQLite 自己的 1000 页自动阈值会把 WAL 顶到 ~4.12MB。
  //   低于 2MB 才能证明「是我们主动收的」,而不是「撞到自动阈值被动收的」。
  //   —— 只断言「主库变大了」是不够的:自动阈值也会让主库变大,两个假设分不开。
  assert.ok(peak < 2_000_000,
    `WAL 峰值 ${(peak / 1048576).toFixed(2)}MB,顶到自动阈值了 —— 事务里那次收口是空炮\n${r.err}`);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('退出:真服务器吃 SIGTERM,WAL 折回主库', { skip: process.platform === 'win32' }, async () => {
  const dir = tmp();
  const db = path.join(dir, 'app.db');
  const child = spawn(process.execPath, ['server.js'], {
    cwd: REPO,
    env: {
      ...process.env, DATA_DIR: dir, STORE_BACKEND: 'sqlite', PORT: '0',
      EMBEDDING_MODEL: '', MEMORY_EXTRACT_EVERY: '0', HEARTBEAT_ENABLED: 'false', TUNNEL: '',
    },
  });
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { out += d; });

  const started = await new Promise((res) => {
    const t = setTimeout(() => res(false), 60000);   // 负载敏感型:起真 server + 轮询,放宽上限
    const iv = setInterval(() => {
      if (/listening on/i.test(out)) { clearTimeout(t); clearInterval(iv); res(true); }
    }, 50);
  });
  assert.ok(started, `服务器没起来:\n${out}`);

  // ★ 前置断言:SIGTERM 之前 WAL 里必须真有东西。
  //   否则这个测试就是自欺 —— WAL 本来就是 0,退出钩子根本没被考察。
  //   (探针分不清两个假设,就等于没探。这一晚已经栽过一次。)
  const walBefore = sz(db + '-wal');
  assert.ok(walBefore > 0, `前置不成立:SIGTERM 前 WAL 就是 ${walBefore},这条测试测不到东西`);

  child.kill('SIGTERM');
  const code = await new Promise((res) => child.on('close', res));

  assert.equal(sz(db + '-wal'), 0, `SIGTERM 后 WAL 应该是 0,实际 ${sz(db + '-wal')}(退出钩子没生效)`);
  assert.ok(sz(db) > 4096, `主库应该拿到数据,实际 ${sz(db)}`);
  assert.ok(code === 0 || code === null, `退出码 ${code}`);
  fs.rmSync(dir, { recursive: true, force: true });
});
