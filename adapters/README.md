# Adapter Templates

These files are examples for adding a new agent provider to the self-hostable server.

- `openai-compatible.template.js`: server-side HTTP adapter for providers exposing `/chat/completions`.
- `local-cli.template.js`: local process adapter using stdin/stdout and `shell: false`.

The current `server.js` already includes OpenAI-compatible behavior inline for an immediately runnable first release. Use the templates when splitting provider logic into separate modules.

Rules for public adapters:

- Never put provider keys in frontend code.
- Never commit session files or CLI logs.
- Do not pass user text through a shell command string.
- Store progress events separately from final chat replies.
