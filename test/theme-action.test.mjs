import assert from 'node:assert/strict';
import test from 'node:test';
import { nextTheme } from '../public/js/actions/theme.js';

test('titlebar theme action keeps the intended cycle order', () => {
  assert.equal(nextTheme('light'), 'island');
  assert.equal(nextTheme('island'), 'starry');
  assert.equal(nextTheme('starry'), 'dark');
  assert.equal(nextTheme('dark'), 'light');
});

test('unknown theme falls back through dark to light', () => {
  assert.equal(nextTheme('unknown'), 'light');
});
