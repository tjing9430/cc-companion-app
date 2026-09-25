// 主题白名单。加 starry 这种"第三个值"最容易出的事:
// 后端放行了、前端没认,或者反过来 —— 两边口径一漂,用户就会拿到一个没有 CSS 的主题名,
// 整页裸奔(变量全空,黑字白底还是白字白底全看运气)。
// 所以这份测试同时钉住**后端归一化**和**前端那张表**,两边必须是同一份名单。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// ★ 这张表是**唯一的真源**:下面五条测试全部由它驱动。
//   加第四个主题时只改这一行,漏改的那一条会自己红 —— 这正是 island 上来时发生的事。
const { THEMES: ALLOWED } = await import('../lib/state.js');

test('后端主题白名单是唯一导出的合法名单', () => {
  assert.deepEqual([...ALLOWED].sort(), ['dark', 'island', 'light', 'starry']);
});

test('前端 applyTheme 用的是同一份名单', () => {
  const src = fs.readFileSync(path.join(REPO, 'public', 'app.js'), 'utf8');
  assert.match(src, /state\.themes/);
  assert.doesNotMatch(src, /\[['"](?:dark|light|starry|island)/,
    '前端不应再复制一份主题白名单');
});

test('服务端首帧注入也用同一份主题名单', () => {
  const src = fs.readFileSync(path.join(REPO, 'server.js'), 'utf8');
  assert.match(src, /THEMES\.includes\(theme\)/);
});

test('每个主题在 CSS 里都真的有一套变量(名单里有、样式里没有 = 裸奔)', () => {
  const css = fs.readFileSync(path.join(REPO, 'public', 'styles.css'), 'utf8');
  for (const t of ALLOWED) {
    if (t === 'light') { assert.match(css, /^:root\{/m, 'light 走 :root'); continue; }
    assert.ok(css.includes(`body[data-theme="${t}"]{`), `${t} 没有自己的变量块`);
  }
});

test('设置页把每个主题都列出来了(后端支持但选不到 = 等于没有)', () => {
  const src = fs.readFileSync(path.join(REPO, 'public', 'js', 'settings-view.js'), 'utf8');
  for (const t of ALLOWED) {
    assert.match(src, new RegExp(`(?:^|[,{ ])${t}:`), `设置页缺 ${t} 的显示名称`);
  }
  assert.match(src, /state\.themes/, '设置页必须按服务端名单生成主题选项');
});

test('starry 必须吃到深色家族的可读性修正(不然它会掉回浅色规则)', () => {
  const css = fs.readFileSync(path.join(REPO, 'public', 'styles.css'), 'utf8');
  // 真机截图量到过:少了 .mem-home 这条,记忆页在深空底上整页浅色纸,白得刺眼。
  for (const sel of ['.mem-home', '.mem-note-tape', '.body-text.md .md-link']) {
    const dark = css.includes(`body[data-theme="dark"] ${sel}`);
    const starry = css.includes(`body[data-theme="starry"] ${sel}`);
    assert.equal(dark && !starry, false,
      `${sel} 有 dark 的深色修正却没有 starry 的 —— starry 会掉回浅色值`);
  }
});

test('island 是浅色家族:不能吃到 dark 专属的深色修正', () => {
  const css = fs.readFileSync(path.join(REPO, 'public', 'styles.css'), 'utf8');
  // ★ starry 的风险是「掉回浅色」,island 的风险**方向相反**:
  //   有人图省事把深色修正写成 `body:not([data-theme="light"])`,island 就会被卷进去,
  //   深色文字色配浅色底 = 看不见。这条钉住:凡是深色家族的选择器,必须是**列举式**的。
  const bad = css.match(/body:not\(\[data-theme="light"\]\)/g) || [];
  assert.equal(bad.length, 0,
    '出现了 `:not([data-theme="light"])` 这种"除了浅色都算深色"的写法 —— island 会被误伤');
});

test('island 首屏素材齐全(名单里有主题、目录里没有图 = 首屏一片空)', () => {
  const dir = path.join(REPO, 'public', 'assets', 'island');
  for (const f of ['private', 'group', 'memory', 'console', 'settings', 'more']) {
    const p = path.join(dir, `${f}.webp`);
    assert.ok(fs.existsSync(p), `缺 island/${f}.webp`);
    // 单张预算。★ 不写"总量"是因为总量超了不知道该压哪张。
    assert.ok(fs.statSync(p).size <= 110 * 1024, `island/${f}.webp 超过 110KB`);
  }
});
