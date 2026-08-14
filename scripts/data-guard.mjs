// 跑测试不许碰 data/ —— 快照 + 比对。
//
// ★ 为什么需要它:`lib/state.js` 在**被 import 的那一刻**就 `mkdirSync(DATA_DIR)` 并开库,
//   而 DATA_DIR 不设环境变量时就是**仓库目录下的 data/**。
//   于是任何一个静态 import 了它的测试(哪怕只为拿一个纯函数),
//   都会在仓库里建库、写盘 —— 在部署树里跑,那就是用户的活库。
//   2026-08-14 实测:sqlite 后端下 `avatar.test.mjs` 会在 data/ 里造出一个 114688 字节的 app.db。
//
// ★ 为什么不做成一条普通测试:`node --test` 的文件顺序不保证,
//   守卫可能**跑在肇事者前面**,那就是一条永远绿的假保护。
//   做成 pretest/posttest 一头一尾,它必然在全部测试之后跑。
//
// ★ 为什么是「快照比对」而不是「断言 data/ 不存在」:
//   部署树里 data/ 本来就有用户的库。判据必须是「**这次测试有没有改动它**」,
//   不是「它在不在」—— 后者在唯一真正危险的场景下会永远红,然后被人关掉。

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA = path.join(ROOT, 'data');
const SNAP = path.join(os.tmpdir(), `ccc-data-guard-${path.basename(ROOT)}.json`);

// 目录指纹:相对路径 → 大小 + mtime(毫秒)。
// ★ 不读文件内容:守卫自己不该去碰用户的库(和 #70① 那把 readOnly 尺子同一个道理 ——
//   观测者不许给被观测对象添字节,这里更进一步:连读都不读)。
// ★ 用 size+mtimeMs 而不是只用 size:同长度覆写(比如把一行换成另一行)也要看得见。
function fingerprint(dir) {
  const out = {};
  const walk = (rel) => {
    let ents;
    try { ents = fs.readdirSync(path.join(dir, rel), { withFileTypes: true }); } catch { return; }
    for (const e of ents.sort((a, b) => a.name.localeCompare(b.name))) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) { walk(r); continue; }
      try {
        const st = fs.statSync(path.join(dir, r));
        out[r] = `${st.size}:${Math.round(st.mtimeMs)}`;
      } catch { /* 竞态中消失的文件,下面 diff 会当成"没了" */ }
    }
  };
  if (fs.existsSync(dir)) walk('');
  return out;
}

// 两个指纹的差异。返回人话列表,空数组 = 没动过。
function diff(before, after) {
  const bad = [];
  for (const k of Object.keys(after)) {
    if (!(k in before)) bad.push(`新建  data/${k}`);
    else if (before[k] !== after[k]) bad.push(`改动  data/${k}  (${before[k]} → ${after[k]})`);
  }
  for (const k of Object.keys(before)) if (!(k in after)) bad.push(`删除  data/${k}`);
  return bad.sort();
}

function snapshot() {
  fs.writeFileSync(SNAP, JSON.stringify({ at: Date.now(), fp: fingerprint(DATA) }));
}

function check() {
  if (!fs.existsSync(SNAP)) {
    // ★ 快照不在 = 这一轮没走 pretest。**不能当成通过** —— 那正是「缺席算通过」。
    console.error('[data-guard] ❌ 找不到基线快照,说明 pretest 没跑。这不算通过。');
    console.error('             直接跑 `node --test` 会绕开守卫;请用 `npm test`。');
    process.exit(1);
  }
  const { fp } = JSON.parse(fs.readFileSync(SNAP, 'utf8'));
  const bad = diff(fp, fingerprint(DATA));
  fs.rmSync(SNAP, { force: true });
  if (!bad.length) return;
  console.error('\n[data-guard] ❌ 这轮测试动了仓库里的 data/:');
  for (const b of bad) console.error('   ' + b);
  console.error(`
  为什么这是问题:DATA_DIR 不设环境变量时 = 仓库目录下的 data/。
  在**部署树**里跑,这就是用户的活库(app.db 和正在跑的服务并发共持)。
  修法:让那个测试在 **await import() 之前**设 process.env.DATA_DIR = fs.mkdtempSync(...)。
  ⚠️ 不能用静态 import —— ESM 的 import 会被提升,在模块体第一行之前就执行完,那时设 env 已经太晚。
`);
  process.exit(1);
}

// ★ 只在**被直接执行**时跑 CLI。少了这道判断,测试 import 它去验 diff 逻辑时
//   会撞进下面的 else 分支直接 process.exit(2) —— 测试进程当场死掉,
//   而那看起来会像"测试文件本身有问题",没人会怀疑到这里。
if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const mode = process.argv[2];
  if (mode === 'snapshot') snapshot();
  else if (mode === 'check') check();
  else { console.error('用法: data-guard.mjs snapshot|check'); process.exit(2); }
}

export { fingerprint, diff };
