// Keep the repository's real .env out of tests. Many integration tests spawn
// server.js with a mostly inherited environment; without this guard a local
// DSH/API/tunnel configuration silently changes what those fixtures exercise.
import { spawnSync } from 'node:child_process';

const result = spawnSync(process.execPath, ['--test', ...process.argv.slice(2)], {
  stdio: 'inherit',
  env: { ...process.env, CC_SKIP_DOTENV: '1' },
});

if (result.error) throw result.error;
process.exit(result.status == null ? 1 : result.status);
