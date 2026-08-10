// 语法体检:自动遍历所有 JS 文件跑 node --check,新增文件不用手动登记。
// (以前是 package.json 里手写文件清单,漏登记的文件就是体检盲区。)
// 不用 fs.globSync —— 那是 Node 22+ 的糖,引擎下限是 18。
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const DIRS = ['.', 'lib', 'public', 'adapters', 'bridge', 'scripts'];
const files = [];
for (const dir of DIRS) {
  let entries = [];
  try { entries = fs.readdirSync(dir); } catch { continue; }
  for (const name of entries) {
    if (!/\.(js|mjs)$/.test(name)) continue;
    const p = dir === '.' ? name : path.join(dir, name);
    if (fs.statSync(p).isFile()) files.push(p);
  }
}
files.sort();

let failed = 0;
for (const file of files) {
  const out = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
  if (out.status !== 0) {
    failed += 1;
    console.error(`✗ ${file}\n${out.stderr}`);
  }
}
console.log(`checked ${files.length} files, ${failed} failed`);
process.exit(failed ? 1 : 0);
