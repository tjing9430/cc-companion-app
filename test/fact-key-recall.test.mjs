// 事实键的**全部价值**在这一条:被顶替的记忆不能再进喂给模型的召回。
//
// 为什么单独一个文件:fact-key.test.mjs 验的是字段(superseded_by 有没有写对),
// 那些断言在「三个过滤点被删掉一个」时**照样全绿** —— 字段还是对的,只是没人用它过滤了。
// 这份验的是行为,而且带反面对照:摘掉顶替标记后旧事实必须重新漏进来,
// 否则就证明挡住它的另有其人,这条测试也就没在测它以为在测的东西。
//
// 2026-08-10 起源:这个对照我当时是手工 vm 跑的,没落盘;当晚仓库就被重构成 13 个模块,
// 三个过滤点全靠人眼确认还在。「验过一次 ≠ 钉住」,所以补这一份。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// 先把数据目录指到临时地方再动态 import —— 静态 import 会提升,那样 state.js
// 会去读真实的 data/,测试不该碰用户的库。
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'fkrecall-'));
const { store } = await import('../lib/state.js');
const { selectRelevantMemories, findSimilarMemory, activeMemories } = await import('../lib/memory.js');

const OLD = {
  id: 1, title: '住处', content: '小南住在青禾镇', tags: ['fact'], fact_key: '住处',
  pinned: false, created_at: '2026-08-01T00:00:00.000Z', updated_at: '2026-08-01T00:00:00.000Z',
};
const NEW = {
  id: 2, title: '住处', content: '小南搬到白露城了', tags: ['fact'], fact_key: '住处',
  superseded_by: null, superseded_at: '',
  pinned: false, created_at: '2026-08-10T00:00:00.000Z', updated_at: '2026-08-10T00:00:00.000Z',
};
function seed(oldSupersededBy) {
  store.memories = [
    { ...OLD, superseded_by: oldSupersededBy, superseded_at: oldSupersededBy ? '2026-08-10T00:00:00.000Z' : '' },
    { ...NEW },
  ];
}

test('被顶替的事实不进召回(词法路)', () => {
  seed(2);
  const hits = selectRelevantMemories('她住在哪里', 8);
  assert.ok(hits.some((m) => m.id === 2), '新事实要在');
  assert.ok(!hits.some((m) => m.id === 1), '过时的「住在长沙」不许进 prompt');
});

test('反面对照:摘掉顶替标记,旧事实必须重新漏进来', () => {
  seed(null);
  const hits = selectRelevantMemories('她住在哪里', 8);
  assert.ok(hits.some((m) => m.id === 1) && hits.some((m) => m.id === 2),
    '两条都进 —— 这是修之前的原样。若这里也只有一条,说明挡住旧事实的不是顶替机制,上一条测试就是假绿');
});

test('查询词为空时走的那条短路也要挡(容易漏的分支)', () => {
  seed(2);
  const hits = selectRelevantMemories('   ', 8);
  assert.ok(!hits.some((m) => m.id === 1), '没有查询词时会直接取最近几条,这条路同样不能放过时事实');
});

test('置顶的被顶替记忆也不许翻墙', () => {
  seed(2);
  store.memories[0].pinned = true;   // 置顶在召回里有特权通道
  const hits = selectRelevantMemories('她住在哪里', 8);
  assert.ok(!hits.some((m) => m.id === 1), '置顶不能成为过时事实的后门');
});

test('去重只跟在效的比:被顶替的旧事实不该挡住新记忆入库', () => {
  seed(2);
  assert.equal(findSimilarMemory('小南住在青禾镇'), null,
    '拿一条已被顶替的旧事实去挡新记忆,等于让过时内容继续说话');
});

test('activeMemories 本身:进什么出什么', () => {
  assert.deepEqual(activeMemories([{ id: 1, superseded_by: 2 }, { id: 2 }]).map((m) => m.id), [2]);
  assert.deepEqual(activeMemories(null), []);
  assert.deepEqual(activeMemories([null, undefined, { id: 3 }]).map((m) => m.id), [3]);
});

// 语义召回那条路要真跑得配 embedding 提供方,单测里够不着。
// 退而求其次做结构守卫:它必须还在用 activeMemories 过滤。
// 这条守卫很笨,但它挡的是"重构时三个过滤点漏掉一个"——那正是行为测试够不着的地方。
test('结构守卫:语义召回那条路也必须过滤(单测跑不到它,只能盯源码)', () => {
  const src = fs.readFileSync(path.join(REPO, 'lib/memory.js'), 'utf8');
  const semantic = src.slice(src.indexOf('async function semanticRecall'));
  const body = semantic.slice(0, semantic.indexOf('\n}\n'));
  assert.match(body, /activeMemories\(/,
    'semanticRecall 里的候选集必须过 activeMemories —— 两条召回路漏一条,这功能就等于没做');
});
