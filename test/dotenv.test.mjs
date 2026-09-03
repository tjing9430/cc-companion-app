// .env 解析:行尾注释必须剥掉。不剥的话 `KEY=value  # 说明` 会把整句注释当成值,
// 配置看着是对的、行为却是错的 —— 比直接报错更难查(2026-08-10 真栽:CLAUDE_EFFORT
// 被读成 "xhigh   # 交互态拿 thinking 正文的必需项之一",于是 thinking 一直是空的)。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

// import.meta.dirname 要 Node 20.11+,引擎下限是 18,走 fileURLToPath 老路
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// 两份实现(server.js 和 bridge/index.js)是孪生的,一起验,免得只修一边。
function parseWith(file, envText) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dotenv-'));
  const envPath = path.join(dir, '.env');
  fs.writeFileSync(envPath, envText);
  const src = fs.readFileSync(path.join(REPO, file), 'utf8').replace(/\r\n/g, '\n');
  const fn = src.slice(src.indexOf('function loadDotEnv'));
  const body = fn.slice(0, fn.indexOf('\n}\n') + 3);
  const script = `
    const fs = require('node:fs');
    ${body}
    loadDotEnv(${JSON.stringify(envPath)});
    console.log(JSON.stringify(process.env));
  `;
  const out = spawnSync(process.execPath, ['-e', script], { encoding: 'utf8', env: { PATH: process.env.PATH } });
  fs.rmSync(dir, { recursive: true, force: true });
  if (out.status !== 0) throw new Error(out.stderr);
  return JSON.parse(out.stdout);
}

for (const file of ['lib/env.js', 'bridge/index.js']) {
  test(`${file}: 行尾注释不进值里`, () => {
    const env = parseWith(file, 'CLAUDE_EFFORT=xhigh   # 拿 thinking 的必需项\n');
    assert.equal(env.CLAUDE_EFFORT, 'xhigh');
  });

  test(`${file}: 引号里的 # 是内容,不能剥`, () => {
    const env = parseWith(file, 'PASS="a b#c"\nTOKEN=\'x #y\'\n');
    assert.equal(env.PASS, 'a b#c');
    assert.equal(env.TOKEN, 'x #y');
  });

  test(`${file}: 值内部紧挨着的 # 不算注释(URL 锚点、密码)`, () => {
    const env = parseWith(file, 'URL=http://x/y#frag\nPW=abc#def\n');
    assert.equal(env.URL, 'http://x/y#frag');
    assert.equal(env.PW, 'abc#def');
  });

  test(`${file}: 整行注释和空行照旧跳过`, () => {
    const env = parseWith(file, '# 整行注释\n\nA=1\n');
    assert.equal(env.A, '1');
  });

  test(`${file}: 普通值不受影响`, () => {
    const env = parseWith(file, 'B=plain\nC=with spaces\n');
    assert.equal(env.B, 'plain');
    assert.equal(env.C, 'with spaces');
  });
}
