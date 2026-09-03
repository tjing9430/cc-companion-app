import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { ROOT_DIR } from './state.js';
import { HttpError } from './http-util.js';

const EDITABLE_EXTENSIONS = new Set(['.md', '.txt', '.json', '.jsonc', '.yaml', '.yml', '.toml', '.py', '.js', '.mjs', '.cjs', '.ts', '.sh', '.ps1']);
const SKIP_DIRS = new Set(['.git', 'node_modules', '__pycache__', '.venv', 'venv', 'dist', 'build', 'data', 'uploads']);
const MAX_FILE_BYTES = 1024 * 1024;
const MAX_FILES = 500;

function fileId(filePath) {
  return crypto.createHash('sha256').update(path.resolve(filePath).toLowerCase()).digest('hex').slice(0, 24);
}

function safeStat(filePath) {
  try {
    const stat = fs.statSync(filePath);
    return stat.isFile() && stat.size <= MAX_FILE_BYTES ? stat : null;
  } catch { return null; }
}

function displayPath(filePath, workspace, home) {
  const absolute = path.resolve(filePath);
  if (absolute === home || absolute.startsWith(`${home}${path.sep}`)) return `~${path.sep}${path.relative(home, absolute)}`;
  if (absolute === workspace || absolute.startsWith(`${workspace}${path.sep}`)) return `workspace${path.sep}${path.relative(workspace, absolute)}`;
  return path.basename(absolute);
}

function walk(root, accept, output, depth = 0) {
  if (!root || !fs.existsSync(root) || output.length >= MAX_FILES || depth > 6) return;
  let entries = [];
  try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { return; }
  for (const entry of entries) {
    if (output.length >= MAX_FILES) break;
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) walk(full, accept, output, depth + 1);
    } else if (entry.isFile() && accept(full)) output.push(full);
  }
}

function inventory() {
  const workspace = path.resolve(String(process.env.DSH_CWD || '').trim() || path.resolve(ROOT_DIR, '..'));
  const home = path.resolve(os.homedir());
  const rows = [];
  const seen = new Set();
  const add = (kind, filePath) => {
    let real;
    try { real = fs.realpathSync(filePath); } catch { return; }
    if (seen.has(real)) return;
    const ext = path.extname(real).toLowerCase();
    const stat = safeStat(real);
    if (!stat || !EDITABLE_EXTENSIONS.has(ext)) return;
    if (/(^|[\\/])(\.env|credentials?|secrets?|tokens?)([.\\/]|$)/i.test(real)) return;
    seen.add(real);
    rows.push({
      id: fileId(real), kind, name: path.basename(real), path: real,
      display_path: displayPath(real, workspace, home), size: stat.size,
      updated_at: stat.mtime.toISOString(),
    });
  };

  const skillRoots = [
    path.join(home, '.agents', 'skills'), path.join(home, '.codex', 'skills'),
    path.join(home, '.claude', 'skills'), path.join(workspace, '.agents', 'skills'),
    path.join(workspace, '.claude', 'skills'),
  ];
  for (const root of skillRoots) {
    const files = []; walk(root, (file) => EDITABLE_EXTENSIONS.has(path.extname(file).toLowerCase()), files);
    files.forEach((file) => add('skill', file));
  }

  const hookCandidates = [
    path.join(home, '.claude', 'settings.json'), path.join(home, '.claude', 'settings.local.json'),
    path.join(workspace, '.claude', 'settings.json'), path.join(workspace, '.claude', 'settings.local.json'),
  ];
  hookCandidates.forEach((file) => add('hook', file));
  for (const root of [path.join(home, '.claude', 'hooks'), path.join(workspace, '.claude', 'hooks'), path.join(home, '.codex', 'hooks')]) {
    const files = []; walk(root, (file) => EDITABLE_EXTENSIONS.has(path.extname(file).toLowerCase()), files);
    files.forEach((file) => add('hook', file));
  }

  for (const root of [workspace, ROOT_DIR]) {
    let entries = [];
    try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { continue; }
    entries.filter((entry) => entry.isFile() && ['.md', '.markdown'].includes(path.extname(entry.name).toLowerCase()))
      .forEach((entry) => add('md', path.join(root, entry.name)));
  }

  const order = { md: 0, hook: 1, skill: 2 };
  return rows.sort((a, b) => order[a.kind] - order[b.kind] || a.name.localeCompare(b.name, 'zh-CN'));
}

function listConfigFiles() {
  return inventory().map(({ path: _path, ...row }) => row);
}

function findConfigFile(id) {
  return inventory().find((row) => row.id === String(id || '')) || null;
}

function readConfigFile(id) {
  const row = findConfigFile(id);
  if (!row) throw new HttpError(404, 'config_file_not_found', '文件不存在或不在允许的配置目录中');
  return { ...row, path: undefined, content: fs.readFileSync(row.path, 'utf8') };
}

function updateConfigFile(id, content) {
  const row = findConfigFile(id);
  if (!row) throw new HttpError(404, 'config_file_not_found', '文件不存在或不在允许的配置目录中');
  const text = String(content ?? '');
  if (Buffer.byteLength(text, 'utf8') > MAX_FILE_BYTES) throw new HttpError(413, 'config_file_too_large', '文件内容超过 1MB');
  if (path.extname(row.path).toLowerCase() === '.json' || path.extname(row.path).toLowerCase() === '.jsonc') {
    if (path.extname(row.path).toLowerCase() === '.json') {
      try { JSON.parse(text); } catch (err) { throw new HttpError(400, 'invalid_json', `JSON 格式错误：${err.message}`); }
    }
  }
  const mode = fs.statSync(row.path).mode;
  const temp = `${row.path}.ccc-${process.pid}-${Date.now()}.tmp`;
  fs.writeFileSync(temp, text, { encoding: 'utf8', mode });
  fs.renameSync(temp, row.path);
  return readConfigFile(id);
}

export { listConfigFiles, readConfigFile, updateConfigFile };
