// 模型钮 / 思考档钮。
//
// ★ 这份测试存在的理由是一次真实事故:钮点了没反应,而我之前「验过」——
//   我用 curl 从 App 代理一路打到桥进程,报「整条链通了」。
//   **但断点在更上面**:change 监听器第一行 `if (!(input instanceof HTMLInputElement)) return;`
//   而 <select> 是 HTMLSelectElement,不继承 HTMLInputElement —— 分支从上线起一次没执行过。
//   教训:**验一个按钮,得从按钮开始验,不是从它底下的 API 开始验。**
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const APP = fs.readFileSync(path.join(REPO, 'public', 'app.js'), 'utf8');

test('★★ change 监听器必须在 HTMLInputElement 守卫**之前**接住 select', () => {
  const guard = APP.indexOf('if (!(input instanceof HTMLInputElement)) return;');
  const sel = APP.indexOf("input instanceof HTMLSelectElement && input.dataset.action === 'bridge-dial'");
  assert.ok(sel > 0, '找不到 select 的处理分支');
  assert.ok(guard > 0, '找不到那道守卫');
  assert.ok(sel < guard,
    '★ select 分支排在 HTMLInputElement 守卫后面 —— 那道守卫会把 <select> 的 change 直接 return 掉,钮就是死的');
});

test('★ 拉完桥配置要重绘,否则面板永远晚一拍才出现', () => {
  const i = APP.indexOf('async function loadBridgeConfig');
  assert.ok(i > 0, 'loadBridgeConfig 不见了');
  const block = APP.slice(i, APP.indexOf('\nasync function ', i + 10));
  assert.match(block, /render\(\)/,
    '★ 只改 state 不重绘 = 请求回来时那一帧已经画完了,用户看到的是「没有这块」');
});

test('★★ model 为空时,选中项不许是任何一个真实模型名', async () => {
  globalThis.localStorage ||= { getItem: () => '', setItem: () => {}, removeItem: () => {} };
  globalThis.window ||= globalThis;
  globalThis.matchMedia ||= () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  globalThis.document ||= { querySelector: () => null, querySelectorAll: () => [], body: {} };
  const { renderDialPanel } = await import('../public/js/console-view.js');
  const { state } = await import('../public/js/state.js');
  const MODELS = ['claude-fable-5', 'claude-opus-5', 'claude-sonnet-5'];
  state.settings = { appName: 'CC', userName: '我', assistantName: 'AI' };
  state.bridge = {
    available: true, model: '', effort: 'xhigh', context_window: 200000,
    models: MODELS, efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
    usage: { turns: 1, output_tokens: 4, last_turn_prompt: 102 },
  };
  const html = renderDialPanel();
  // 找出模型下拉里带 selected 的那个 option
  const modelSel = html.slice(html.indexOf('data-field="model"'));
  const selected = modelSel.slice(0, modelSel.indexOf('</select>')).match(/<option value="([^"]*)"[^>]*selected[^>]*>([^<]*)</);
  assert.ok(selected, '模型下拉里没有任何 selected 项 —— 浏览器会自己选第一个,那就是撒谎');
  assert.equal(selected[1], '', `★ 选中项的 value 是 "${selected[1]}" —— 桥根本没设模型,界面却宣称正在用它`);
  assert.ok(!MODELS.includes(selected[2].trim()),
    `★ 选中项显示的是真实模型名「${selected[2]}」—— 没人设过它,显示它就是撒谎,比不显示更糟`);
});

test('model 有值时,选中的就是那一个', async () => {
  const { renderDialPanel } = await import('../public/js/console-view.js');
  const { state } = await import('../public/js/state.js');
  state.bridge = { ...state.bridge, model: 'claude-opus-5' };
  const html = renderDialPanel();
  const modelSel = html.slice(html.indexOf('data-field="model"'));
  const m = modelSel.slice(0, modelSel.indexOf('</select>')).match(/<option value="([^"]*)"[^>]*selected/);
  assert.equal(m && m[1], 'claude-opus-5');
  assert.ok(!modelSel.includes('跟随默认'), '有值时不该再摆「跟随默认」');
});
