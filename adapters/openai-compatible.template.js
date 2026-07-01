/**
 * OpenAI-compatible adapter template.
 *
 * Integrate by importing `generateReply` from your server's adapter switch.
 * The API key stays server-side in environment variables.
 */
export async function generateReply({ systemPrompt, userText, env = process.env, fetchImpl = fetch }) {
  const apiKey = String(env.OPENAI_API_KEY || '').trim();
  if (!apiKey) throw new Error('OPENAI_API_KEY is required');

  const baseUrl = String(env.OPENAI_BASE_URL || 'https://api.openai.com/v1').replace(/\/+$/, '');
  const model = String(env.OPENAI_MODEL || 'gpt-4.1-mini');
  const response = await fetchImpl(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userText },
      ],
      temperature: 0.7,
    }),
  });

  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(body.error?.message || `Agent API returned HTTP ${response.status}`);
  }
  const text = body.choices?.[0]?.message?.content;
  if (!text) throw new Error('Agent API returned no reply text');
  return String(text);
}
