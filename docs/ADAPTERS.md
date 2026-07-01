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

## cc-connect Bridge (Recommended for Claude Code)

Instead of managing the CLI process directly, use [cc-connect](https://github.com/chenhg5/cc-connect) to bridge Claude Code CLI to this app. cc-connect handles session management, message routing, and streaming — and preserves access to MCP tools and extended thinking.

```bash
npm install -g cc-connect
cc-connect start --url http://localhost:8787
```

See [CC-CONNECT.md](CC-CONNECT.md) for the full setup guide.
