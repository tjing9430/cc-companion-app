import { spawn } from 'node:child_process';

/**
 * Local CLI adapter template.
 *
 * Uses `spawn` with `shell: false`. Do not interpolate user input into a shell command.
 * The configured program must accept a prompt on stdin and print only its final reply.
 */
export function generateReply({ systemPrompt, userText, env = process.env }) {
  const command = String(env.AGENT_COMMAND || '').trim();
  if (!command) return Promise.reject(new Error('AGENT_COMMAND is required'));

  let args = [];
  try {
    args = env.AGENT_ARGS_JSON ? JSON.parse(env.AGENT_ARGS_JSON) : [];
  } catch {
    return Promise.reject(new Error('AGENT_ARGS_JSON must be a JSON array'));
  }
  if (!Array.isArray(args) || args.some((arg) => typeof arg !== 'string')) {
    return Promise.reject(new Error('AGENT_ARGS_JSON must contain string arguments only'));
  }

  const timeoutMs = Math.max(1000, Number(env.AGENT_TIMEOUT_MS || 120000));
  const prompt = `${systemPrompt}\n\nUser:\n${userText}\n\nAssistant:\n`;

  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      shell: false,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: process.env,
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error('Local agent timed out'));
    }, timeoutMs);

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) return reject(new Error(stderr.trim() || `Local agent exited with ${code}`));
      const reply = stdout.trim();
      if (!reply) return reject(new Error('Local agent returned an empty reply'));
      resolve(reply);
    });
    child.stdin.end(prompt);
  });
}
