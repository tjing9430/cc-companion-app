# Agent Adapters

The first public version ships with two adapter modes.

## Mock Agent

No configuration required. This mode returns deterministic local replies and is useful for development, screenshots, and UI testing.

## OpenAI-Compatible Agent

Set these environment variables:

```bash
OPENAI_API_KEY=your-key
OPENAI_BASE_URL=https://api.openai.com/v1
OPENAI_MODEL=gpt-4.1-mini
```

The server sends a `POST /chat/completions` request with:

- one system prompt containing recent memory notes
- one user message containing the latest chat text

Any compatible provider can be used.

Template:

```text
adapters/openai-compatible.template.js
```

## Local CLI Agents

For Claude Code, Codex, or another local CLI, copy the included process adapter template and wire it into the provider switch:

```bash
AGENT_PROVIDER=local-cli
AGENT_COMMAND=your-command
AGENT_ARGS_JSON=["--some-flag"]
```

Template:

```text
adapters/local-cli.template.js
```

The template uses stdin/stdout and starts the process with `shell: false`. Keep local CLI session files, logs, and permission state out of the public repository.

## Built-in Claude Code Bridge (Recommended for Claude Code)

Instead of wiring the CLI in as a request/response local adapter, use the built-in bridge
shipped in [`bridge/`](../bridge/). It presents an OpenAI-compatible endpoint that the app
talks to as a provider, and runs `claude -p --output-format stream-json` under the hood —
so you keep your Claude subscription (no API key) and your MCP tools, with tool activity
streamed to the Console.

```bash
# .env: point the provider at the bridge
OPENAI_API_KEY=bridge
OPENAI_BASE_URL=http://127.0.0.1:8788/v1
OPENAI_MODEL=claude-code

# then, in a second terminal
npm run bridge
```

The bridge binds to `127.0.0.1` only and needs no code changes to `server.js`. Note that
headless `-p` does not expose raw thinking on a subscription (v1 limitation).

See [CC-CONNECT.md](CC-CONNECT.md) for the full setup guide, session management, and security notes.
