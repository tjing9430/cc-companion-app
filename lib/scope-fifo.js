// lib/scope-fifo.js — per-scope FIFO serialization + per-turn latency instrumentation.
//
// Phase 1 (repo optimization). Two properties this guarantees:
//   1. Same-scope reply generation runs strictly in arrival order, so two concurrent
//      messages in one scope can never interleave or land their replies out of order.
//   2. A single failing turn must NOT wedge the queue — the next same-scope turn still runs.
// Different scopes are independent and stay concurrent.
//
// This is the prerequisite for later async-ack work: you cannot safely return before the
// reply is produced unless ordering is already guaranteed here.

const scopeChains = new Map(); // scope -> Promise (tail of that scope's chain)

// Run `task` (a `() => Promise`) after every previously-enqueued task for the same scope
// has SETTLED (fulfilled or rejected). Returns the task's own promise, so the caller still
// sees the task's result or error. The internal chain tail never rejects, so one failure
// cannot break ordering for the tasks queued behind it.
export function runInScopeOrder(scope, task) {
  const key = String(scope == null ? '' : scope);
  const prev = scopeChains.get(key) || Promise.resolve();
  const result = prev.then(() => task(), () => task());
  const tail = result.then(() => {}, () => {});
  scopeChains.set(key, tail);
  // Opportunistic cleanup: if nothing else was queued behind this task, drop the map entry
  // once it settles so idle scopes don't leak Map keys.
  tail.then(() => {
    if (scopeChains.get(key) === tail) scopeChains.delete(key);
  });
  return result;
}

// --- introspection / test helpers ---
export function _scopeCount() { return scopeChains.size; }
export function agentIsIdle() { return scopeChains.size === 0; }
export function _reset() { scopeChains.clear(); }

// --- per-turn latency instrumentation (admission / recall / agent / final) ---
const now = () => Date.now();

export function newTiming() { return { t0: now(), m: {} }; }

// Record a monotonic-ish mark once (first write wins, so retries don't clobber the first stamp).
export function tmark(t, name) { if (t && t.m && t.m[name] == null) t.m[name] = now(); }

// Break the end-to-end latency into the four segments the pipeline cares about:
//   admission = queue/FIFO wait before this turn started processing
//   recall    = memory + document recall
//   agent     = model round-trip
//   final     = persisting + broadcasting the reply
export function latencySegments(t) {
  const m = (t && t.m) || {};
  const t0 = (t && t.t0) != null ? t.t0 : now();
  const span = (a, b) => (m[a] != null && m[b] != null ? m[b] - m[a] : null);
  return {
    admission_ms: (m.processStart != null ? m.processStart : t0) - t0,
    recall_ms: span('recallStart', 'recallEnd'),
    agent_ms: span('agentStart', 'agentEnd'),
    final_ms: span('agentEnd', 'finalEnd'),
    total_ms: (m.finalEnd != null ? m.finalEnd : now()) - t0,
  };
}

export function formatLatency(scope, seg) {
  const n = (v) => (v == null ? '-' : `${v}ms`);
  return `[latency] scope=${scope} admission=${n(seg.admission_ms)} recall=${n(seg.recall_ms)} agent=${n(seg.agent_ms)} final=${n(seg.final_ms)} total=${n(seg.total_ms)}`;
}
