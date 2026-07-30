import test from 'node:test';
import assert from 'node:assert/strict';
import {
  runInScopeOrder, _reset, _scopeCount,
  newTiming, latencySegments,
} from '../lib/scope-fifo.js';

// A task factory: resolves with `v` after `ms`, or rejects if `fail`.
const task = (ms, v, fail = false) => () =>
  new Promise((resolve, reject) => setTimeout(() => (fail ? reject(new Error('boom:' + v)) : resolve(v)), ms));

test('same-scope tasks run strictly in enqueue order even when later ones are faster', async () => {
  _reset();
  const done = [];
  // A is slow (40ms), B is fast (5ms), both enqueued on the SAME scope, A first.
  // Without FIFO, B would finish first. With FIFO, B must wait for A → order [A, B].
  const pA = runInScopeOrder('chat', task(40, 'A')).then((v) => done.push(v));
  const pB = runInScopeOrder('chat', task(5, 'B')).then((v) => done.push(v));
  await Promise.all([pA, pB]);
  assert.deepEqual(done, ['A', 'B']);
});

test('a single failing turn does not block subsequent same-scope turns', async () => {
  _reset();
  const done = [];
  const pA = runInScopeOrder('chat', task(10, 'A', true)); // rejects
  const pB = runInScopeOrder('chat', task(5, 'B')).then((v) => done.push(v));
  await assert.rejects(pA, /boom:A/); // the caller still sees A's own error
  await pB;
  assert.deepEqual(done, ['B']); // B still ran despite A failing
});

test('ordering holds across a longer same-scope burst with mixed durations', async () => {
  _reset();
  const done = [];
  const durations = [30, 5, 20, 1, 15];
  const ps = durations.map((ms, i) =>
    runInScopeOrder('chat', task(ms, i)).then((v) => done.push(v)));
  await Promise.all(ps);
  assert.deepEqual(done, [0, 1, 2, 3, 4]); // strict enqueue order regardless of duration
});

test('different scopes run concurrently (independent chains)', async () => {
  _reset();
  const done = [];
  // chat is slow, group is fast; different scopes → group finishes first (not serialized behind chat).
  const pChat = runInScopeOrder('chat', task(40, 'chat')).then((v) => done.push(v));
  const pGroup = runInScopeOrder('group', task(5, 'group')).then((v) => done.push(v));
  await Promise.all([pChat, pGroup]);
  assert.deepEqual(done, ['group', 'chat']);
});

test('idle scopes do not leak Map entries', async () => {
  _reset();
  await runInScopeOrder('chat', task(1, 'x'));
  await new Promise((r) => setTimeout(r, 5)); // let the cleanup microtask settle
  assert.equal(_scopeCount(), 0);
});

test('latencySegments splits admission/recall/agent/final/total', () => {
  const t = newTiming();
  t.t0 = 1000;
  t.m = { processStart: 1005, recallStart: 1005, recallEnd: 1025, agentStart: 1025, agentEnd: 1080, finalEnd: 1082 };
  const s = latencySegments(t);
  assert.equal(s.admission_ms, 5);
  assert.equal(s.recall_ms, 20);
  assert.equal(s.agent_ms, 55);
  assert.equal(s.final_ms, 2);
  assert.equal(s.total_ms, 82);
});

test('latencySegments tolerates missing marks without throwing', () => {
  const t = newTiming();
  t.t0 = 0;
  t.m = {};
  const s = latencySegments(t);
  assert.equal(s.recall_ms, null);
  assert.equal(s.agent_ms, null);
  assert.equal(typeof s.total_ms, 'number');
});
