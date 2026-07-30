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

## Console Command Adapters (`/forge` and `/quota`)

The Console tab includes a command composer and shortcut buttons. Commands are stored as console events so they remain visible after refresh.

Available command:

```text
/forge
/quota
```

`/forge` cleans the app's stored history without summarizing, rewriting, or deleting preserved conversation text. It keeps original `user` and `assistant` chat messages, removes tool/thinking/progress/debug style noise, inserts a forge separator message, and records a new local history id.

Standalone behavior: when `FORGE_ADAPTER_URL` is unset, `/forge` is companion-local only. It does not create a real Claude Code / cc-connect session, does not call `claude --resume`, does not start or stop a Claude Code process, does not edit `~/.claude/projects/*.jsonl`, does not copy transcript turns into a new Claude Code session, and does not kill old cc-connect bridge processes. The built-in fallback only changes the companion app's local history rows.

Real adapter behavior: when `FORGE_ADAPTER_URL` is set, `/forge` first POSTs the cleaned history plan to that external adapter. The app commits the local history segment only after the adapter returns a successful 2xx JSON response. This lets a cc-connect or Claude Code adapter perform the real session rotation/process cleanup while the companion app remains the history UI. The adapter must implement the real behavior; the open-source app does not ship private session-rotation code.

Adapter request shape:

```json
{
  "operation": "forge",
  "previous_local_history_id": "session-...",
  "new_local_history_id": "forge-...",
  "created_at": "2026-06-08T00:00:00.000Z",
  "settings": { "userName": "You", "assistantName": "Assistant" },
  "stats": { "kept": 42, "removed_noise": 7 },
  "chat": { "messages": [] },
  "group": { "messages": [] }
}
```

Set `FORGE_ADAPTER_TOKEN` to send both `Authorization: Bearer <token>` and `X-Forge-Token: <token>` headers. A non-2xx response or `{ "ok": false }` aborts the companion-side forge so local history is not changed after a failed real forge.

`/quota` asks an optional quota adapter for remaining usage. The companion app does not know Claude Code, cc-connect, API-provider, or subscription limits by itself. When `QUOTA_ADAPTER_URL` is unset, `/quota` records a clear "not configured" console event.

The Settings tab also shows a persistent quota card. It uses `GET /api/quota` for silent refreshes, so opening Settings or pressing Refresh updates the display without adding Console events. The `/quota` command keeps recording a Console event.

When `QUOTA_ADAPTER_URL` is set, `/quota` sends:

```json
{
  "operation": "quota",
  "requested_at": "2026-06-09T00:00:00.000Z",
  "settings": { "userName": "You", "assistantName": "Assistant" },
  "session": { "current_id": "session-..." }
}
```

The adapter can return common fields such as:

```json
{
  "ok": true,
  "provider": "claude-code",
  "model": "opus",
  "remaining": "about 42%",
  "used": 58,
  "limit": 100,
  "resets_at": "2026-06-09T16:30:00Z"
}
```

For the Settings quota card, adapters may also return richer fields:

```json
{
  "context": { "used": 32000, "limit": 200000, "percent": 16.2 },
  "limit_tier": "5h Claude quota",
  "five_hour": { "remaining": "68.0%", "resets_in": "1h18m", "resets_at": "2026-06-09T13:00:00+08:00" },
  "weekly": { "remaining": "19.0%", "resets_in": "1d13h", "resets_at": "2026-06-11T00:00:00+08:00" }
}
```

`context` represents the agent's current context/token usage. `five_hour` and `weekly` represent remaining quota for those windows.

Set `QUOTA_ADAPTER_TOKEN` to send both `Authorization: Bearer <token>` and `X-Quota-Token: <token>` headers.

Shortcut buttons for `/quota`, `/list`, `/switch`, `/current`, and `/name` are included as UI affordances for future adapter integrations. In the standalone app, commands other than `/forge` and `/quota` are currently recorded as ordinary console command events.
