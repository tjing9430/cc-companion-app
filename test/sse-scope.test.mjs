import assert from 'node:assert/strict';
import test from 'node:test';
import { shouldSendToClient } from '../lib/sse.js';

test('scoped SSE clients receive new scoped event types without a whitelist update', () => {
  assert.equal(shouldSendToClient({ scope: 'chat' }, 'message-stream', { scope: 'chat' }), true);
  assert.equal(shouldSendToClient({ scope: 'chat' }, 'message-stream', { scope: 'group' }), false);
  assert.equal(shouldSendToClient({ scope: 'group' }, 'future-event', { scope: 'group' }), true);
});

test('scoped SSE clients do not receive global events while all-scope clients do', () => {
  assert.equal(shouldSendToClient({ scope: 'chat' }, 'settings', { settings: {} }), false);
  assert.equal(shouldSendToClient({ scope: 'all' }, 'settings', { settings: {} }), true);
});
