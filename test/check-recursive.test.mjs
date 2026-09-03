import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const ROOT = path.resolve(import.meta.dirname, '..');
const CHECK = path.join(ROOT, 'scripts', 'check.mjs');

test('syntax check recursively includes nested public modules', () => {
  const run = spawnSync(process.execPath, [CHECK], { cwd: ROOT, encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr || run.stdout);
  const count = Number(/checked (\d+) files/.exec(run.stdout)?.[1] || 0);
  assert.ok(count >= 50, 'expected at least 50 runtime JS files, got ' + count);
});

test('syntax check fails on a nested invalid module', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ccc-check-'));
  try {
    const nested = path.join(root, 'public', 'js');
    fs.mkdirSync(nested, { recursive: true });
    fs.writeFileSync(path.join(nested, 'broken.js'), 'function broken( {\n');
    const run = spawnSync(process.execPath, [CHECK, '--root', root], { encoding: 'utf8' });
    assert.notEqual(run.status, 0, run.stdout);
    assert.match(run.stdout + '\n' + run.stderr, /public[\\/]js[\\/]broken\.js/);
    assert.match(run.stdout, /checked 1 files, 1 failed/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
