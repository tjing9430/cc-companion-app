import assert from 'node:assert/strict';
import test from 'node:test';
import { nextTheme } from '../public/js/actions/theme.js';

const ORDER = ['light', 'island', 'starry', 'dark'];

test('titlebar theme action keeps the intended cycle order', () => {
  assert.equal(nextTheme('light', ORDER), 'island');
  assert.equal(nextTheme('island', ORDER), 'starry');
  assert.equal(nextTheme('starry', ORDER), 'dark');
  assert.equal(nextTheme('dark', ORDER), 'light');
});

test('unknown theme falls back through dark to light', () => {
  assert.equal(nextTheme('unknown', ORDER), 'light');
});
