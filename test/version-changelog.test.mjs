import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const ROOT = path.resolve(import.meta.dirname, '..');

test('package version has a matching changelog release', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const changelog = fs.readFileSync(path.join(ROOT, 'CHANGELOG.md'), 'utf8');
  assert.match(pkg.version, /^\d+\.\d+\.\d+$/);
  assert.ok(changelog.includes('## [' + pkg.version + ']'), 'CHANGELOG is missing package version ' + pkg.version);
});
