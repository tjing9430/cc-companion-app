/**
 * Turn the app's OpenAI-style `messages` array into the single prompt string
 * that `claude -p` receives.
 *
 * The app builds: [system(persona), ...history, system(参考资料)?, system(相关记忆)?, user]
 *
 * Forwarding only the last user message (what the bridge did originally) silently dropped
 * the recalled documents and memories, so the agent answered from its own filesystem and
 * looked like it had never seen anything the user uploaded.
 *
 * What goes through, and why:
 *   · the run of system messages immediately before the final user message — that is this
 *     turn's recall (documents + memories). This is the whole point of the memory library.
 *   · NOT the history — the resumed CLI session already holds it; re-sending would duplicate
 *     the entire conversation on every turn.
 *   · NOT messages[0], the app's persona prompt — a Claude Code sandbox has its own CLAUDE.md,
 *     and two competing system prompts is worse than one.
 */

export function textOf(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((part) => (typeof part === 'string' ? part : (part && part.text) || '')).join('');
  }
  return '';
}

export function buildPrompt(messages) {
  if (!Array.isArray(messages)) return '';
  let lastUser = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i] && messages[i].role === 'user') { lastUser = i; break; }
  }
  if (lastUser < 0) return '';

  const context = [];
  for (let i = lastUser - 1; i > 0; i--) {   // i > 0 leaves the base system prompt alone
    if (!messages[i] || messages[i].role !== 'system') break;
    const text = textOf(messages[i].content).trim();
    if (text) context.unshift(text);
  }

  const user = textOf(messages[lastUser].content).trim();
  if (!context.length) return user;
  return `${context.join('\n\n')}\n\n---\n\n${user}`;
}
