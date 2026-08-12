// 终端档底下那条状态行。
//
// ★ 这份测试守的是**一条诚实性规则**,不是排版:
//   「取不到的东西不显示,而不是显示成 0 / — / 默认值」。
//   这条规则很容易在后来的某次"顺手补全"里被推翻 —— 比如有人觉得
//   一行里空着不好看,给没有数据的段填个占位符。填完之后界面更整齐了,
//   而用户看到的是**一个我们其实不知道的数字**。这份测试就是拦这个。
import { test } from 'node:test';
import assert from 'node:assert/strict';

globalThis.localStorage = { getItem: () => '', setItem: () => {}, removeItem: () => {} };
const { state } = await import('../public/js/state.js');
const { renderTermStatus } = await import('../public/js/console-view.js');

function withState(patch, fn) {
  const bridge = state.bridge, quota = state.quota;
  Object.assign(state, patch);
  try { return fn(); } finally { state.bridge = bridge; state.quota = quota; }
}

test('什么都取不到时:整条状态行不渲染(不是渲染一条空壳)', () => {
  const html = withState({ bridge: {}, quota: {} }, renderTermStatus);
  assert.equal(html, '', `应当返回空串,实际:${html}`);
});

test('只有模型时:只出模型那一段,别的段一个都不冒出来', () => {
  const html = withState({ bridge: { model: 'claude-fable-5' }, quota: {} }, renderTermStatus);
  assert.match(html, /claude-fable-5/);
  assert.doesNotMatch(html, /上下文/, '没有 usage 就不该有上下文那段');
  assert.doesNotMatch(html, /轮次/);
  assert.doesNotMatch(html, /5h|刷新/, '没查过额度就不该有额度那两段');
});

test('★ 窗口没声明时**不换算百分比** —— 猜出来的百分比看着和真的一样', () => {
  const html = withState({
    bridge: { model: 'm', usage: { last_turn_prompt: 12000 } },   // 没有 context_window
    quota: {},
  }, renderTermStatus);
  assert.match(html, /12k/, '绝对值照出');
  assert.doesNotMatch(html, /%/, '窗口未知时一个百分号都不许出现');
});

test('窗口声明了才给百分比,而且是真算出来的', () => {
  const html = withState({
    bridge: { model: 'm', context_window: 200000, usage: { last_turn_prompt: 50000, turns: 7 } },
    quota: {},
  }, renderTermStatus);
  assert.match(html, /50k\/200k 25%/);
  assert.match(html, /轮次/);
  assert.match(html, />7</);
});

test('额度 adapter 说「没配置」时,额度那两段不出现', () => {
  const html = withState({
    bridge: { model: 'm' },
    quota: { data: { configured: false, five_hour: { percent: 80 } } },
  }, renderTermStatus);
  assert.doesNotMatch(html, /5h/, 'configured:false 就是"这台没有额度能力",不该借着残留字段显示');
});

test('★ 花费那一栏永远不出现 —— 这条链上根本取不到,摆上去就是假的', () => {
  // 别人家 CLI 的状态栏有 $;我们的桥不报。若哪天有人"补齐"了这一栏,
  // 除非它真有数据源,否则这条必须红。
  const html = withState({
    bridge: { model: 'm', context_window: 200000, usage: { last_turn_prompt: 1000, turns: 1 }, cost: 0 },
    quota: { data: { five_hour: { percent: 50, resets_at: '2026-08-12T09:00:00Z' } }, fetched_at: '2026-08-12T07:00:00Z' },
  }, renderTermStatus);
  assert.doesNotMatch(html, /\$|花费|费用/, '取不到的东西不许摆出来');
  // 同一轮里顺便确认:取得到的那几段确实在
  assert.match(html, /5h/);
  assert.match(html, /刷新/);
});

test('用户内容走转义,不能从额度字段里注入标签', () => {
  const html = withState({
    bridge: { model: '<img src=x onerror=alert(1)>' },
    quota: {},
  }, renderTermStatus);
  assert.doesNotMatch(html, /<img/, '模型名来自配置,但它照样得过转义');
  assert.match(html, /&lt;img/);
});
