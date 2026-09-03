import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const self = fileURLToPath(import.meta.url);
const mode = process.argv[2];

if (mode === 'worker') {
  setInterval(() => {}, 1_000);
} else if (mode === 'owner') {
  const marker = process.argv[3];

  // Keep this registration order aligned with server.js: the generic signal
  // handler exists before the tunnel child and its dedicated cleanup hooks.
  process.on('exit', () => fs.appendFileSync(marker, 'flush\n'));
  process.on('SIGINT', () => process.exit(0));

  const worker = spawn(process.execPath, [self, 'worker'], {
    stdio: 'ignore',
  });

  const stopWorker = () => {
    try { worker.kill(); } catch { /* already stopped */ }
  };
  process.on('exit', () => {
    stopWorker();
    fs.appendFileSync(marker, 'stop\n');
  });
  process.on('SIGINT', () => {
    fs.appendFileSync(marker, 'late-signal\n');
    stopWorker();
    process.exit(0);
  });

  worker.once('spawn', () => process.send?.({ workerPid: worker.pid }));
} else {
  test('exit cleanup still stops a tunnel child when an earlier SIGINT handler calls process.exit', {
    skip: process.platform === 'win32' && 'Windows child.kill(SIGINT) does not model a Unix Ctrl+C signal',
  }, async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-exit-cleanup-'));
    const marker = path.join(tempDir, 'events.txt');
    const owner = spawn(process.execPath, [self, 'owner', marker], {
      stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
    });

    const workerPid = await new Promise((resolve, reject) => {
      owner.once('message', ({ workerPid: pid }) => resolve(pid));
      owner.once('error', reject);
      owner.once('exit', (code) => reject(new Error(`owner exited before ready (${code})`)));
    });

    const ownerClosed = new Promise((resolve) => owner.once('close', resolve));
    owner.kill('SIGINT');
    await ownerClosed;

    const deadline = Date.now() + 2_000;
    let workerAlive = true;
    while (workerAlive && Date.now() < deadline) {
      try {
        process.kill(workerPid, 0);
        await new Promise((resolve) => setTimeout(resolve, 25));
      } catch (err) {
        if (err?.code !== 'ESRCH') throw err;
        workerAlive = false;
      }
    }

    const events = fs.readFileSync(marker, 'utf8');
    assert.match(events, /flush/);
    assert.match(events, /stop/);
    assert.doesNotMatch(events, /late-signal/);
    assert.equal(workerAlive, false, `worker ${workerPid} survived its owner's exit cleanup`);
    fs.rmSync(tempDir, { recursive: true, force: true });
  });
}
