// 语法体检：递归遍历运行时代码目录里的 JS/MJS，再逐个跑 node --check。
// 根目录文件单独收集，避免把 node_modules、data、test 等非运行时目录卷进来。
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const DIRS = ['lib', 'public', 'adapters', 'bridge', 'scripts'];

function walkJavaScriptFiles(dir, files) {
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const entry of entries) {
    const filePath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walkJavaScriptFiles(filePath, files);
      continue;
    }
    if (entry.isFile() && /\.(?:js|mjs)$/.test(entry.name)) files.push(filePath);
  }
}

export function collectJavaScriptFiles(root = process.cwd()) {
  const files = [];
  let rootEntries = [];
  try { rootEntries = fs.readdirSync(root, { withFileTypes: true }); } catch { return files; }
  for (const entry of rootEntries) {
    if (entry.isFile() && /\.(?:js|mjs)$/.test(entry.name)) files.push(path.join(root, entry.name));
  }
  for (const dir of DIRS) walkJavaScriptFiles(path.join(root, dir), files);
  return files.sort();
}

export function checkJavaScriptFiles(files, root = process.cwd()) {
  let failed = 0;
  for (const file of files) {
    const out = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
    if (out.status !== 0) {
      failed += 1;
      console.error('✗ ' + path.relative(root, file) + '\n' + out.stderr);
    }
  }
  return failed;
}

const rootIndex = process.argv.indexOf('--root');
const root = rootIndex >= 0 && process.argv[rootIndex + 1]
  ? path.resolve(process.argv[rootIndex + 1])
  : process.cwd();
const files = collectJavaScriptFiles(root);
const failed = checkJavaScriptFiles(files, root);
console.log('checked ' + files.length + ' files, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
