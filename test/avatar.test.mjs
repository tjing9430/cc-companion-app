// 头像:字段校验 + AI 自改窄口。
//
// 这份测试八成的分量在**安全边界**,不在功能。头像这个功能本身很小,
// 但它带来两个新面:一个可写的 URL 字段,和一条给 agent 用的写接口。
// 「AI 能自己换头像」是产品点,可它同时意味着模型输出能直接落进设置项 ——
// 所以这里逐条钉住:外链不行、data URL 不行、路径穿越不行、别的字段一个都别想捎带。
import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeAvatar } from '../lib/state.js';

test('只放行本机 /uploads/ 下的资源引用', () => {
  assert.equal(normalizeAvatar('/uploads/1786370830370-eb6f7da81fb8.png'), '/uploads/1786370830370-eb6f7da81fb8.png');
  assert.equal(normalizeAvatar('/uploads/a_b-c.1.webp'), '/uploads/a_b-c.1.webp');
});

test('★ 外链一律丢掉(否则每次渲染都把用户 IP/UA 送给第三方,还能拿来探内网)', () => {
  for (const bad of [
    'https://evil.example/a.png',
    'http://127.0.0.1:8787/uploads/x.png',
    '//evil.example/a.png',
    'https://evil.example/uploads/a.png',
  ]) assert.equal(normalizeAvatar(bad), '', `${bad} 不该被放行`);
});

test('★ data: URL 一律丢掉(等于开了一条免上传的任意字节写入口)', () => {
  assert.equal(normalizeAvatar('data:image/png;base64,iVBORw0KGgo='), '');
  assert.equal(normalizeAvatar('DATA:image/svg+xml,<svg onload=alert(1)>'), '');
});

test('★ 路径穿越一律丢掉', () => {
  for (const bad of ['/uploads/../../etc/passwd', '/uploads/..%2f..%2fetc', '/uploads/a/../../b', '../uploads/x.png'])
    assert.equal(normalizeAvatar(bad), '', `${bad} 不该被放行`);
});

test('空值/非字符串安全回落成空串,不抛', () => {
  for (const v of [undefined, null, '', '   ', 0, {}, [], true])
    assert.equal(normalizeAvatar(v), '');
});

test('放行的形状里不含目录分隔符 —— 只能是 /uploads/ 下的一层文件名', () => {
  assert.equal(normalizeAvatar('/uploads/sub/dir/a.png'), '', '多层路径不放行');
  assert.equal(normalizeAvatar('/uploads/'), '', '空文件名不放行');
});

test('结构守卫:自改窄口只写 assistant_avatar,不复用 /api/settings', async () => {
  const fs = await import('node:fs');
  const path = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const src = fs.readFileSync(path.join(REPO, 'server.js'), 'utf8');
  const i = src.indexOf("route === '/api/agent/avatar'");
  assert.ok(i > 0, '窄口不见了');
  // ★ 边界要切在**这个 handler 结束的地方**,不能拍脑袋切 900 字符 ——
  //   第一版就是这么切的,直接切进了紧邻的 /api/settings 分支(那里当然调
  //   normalizeSettings),于是断言对着别人的代码报警。假阳性和假阴性一样坏。
  const rest = src.slice(i);
  const nextRoute = rest.indexOf("if (req.method ===", 10);
  const block = nextRoute > 0 ? rest.slice(0, nextRoute) : rest;
  assert.ok(block.includes('normalizeAvatar'), '窄口必须过校验器');
  assert.ok(block.includes('assistant_avatar'), '窄口写的是 assistant_avatar');
  assert.ok(!block.includes('normalizeSettings('), '★ 窄口不许调 normalizeSettings —— 那就等于把整份设置的写权限交出去了');
  assert.ok(block.includes('addConsoleEvent'), '★ 每次自改必须留一条 console 事件(被看见 + 可审计)');
});
