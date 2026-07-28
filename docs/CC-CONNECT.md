# Claude Code Bridge

Use your locally-installed **Claude Code CLI** as the app's AI backend — with your
Claude subscription and no API key. This repo ships a small bridge under
[`bridge/`](../bridge/); you clone one repo and run `npm run bridge`. No extra tool to
install.

> The `cc-connect` npm package is **not** required for this. That package is an upstream
> messaging-platform bridge (Feishu / Telegram / Slack / …) and does not connect Claude
> Code to this app. The built-in bridge described here replaces it.

## How it works

The app already speaks the OpenAI chat-completions shape (see [Mode 1](../README.md#mode-1-standalone-api-direct)).
The bridge implements that same shape locally and runs the Claude Code CLI for each turn,
so **no `server.js` changes are needed** — you just point the app's provider settings at
the bridge.

```
┌──────────────┐   POST /v1/chat/completions   ┌──────────────┐   spawn    ┌──────────────────┐
│  Companion    │ ────────────────────────────▶ │    bridge     │ ─────────▶ │  claude -p        │
│  App (8787)   │ ◀──── reply (+ signatures) ─── │   (8788)      │ ◀─ stream- │  (your CLI +      │
└──────┬───────┘                                └──────┬───────┘   json ───  │   MCP + sub)      │
       │  POST /api/console/events (live tool feed)    │                     └──────────────────┘
       └───────────────────────────────────────────────┘
```

- **Companion App** — serves the UI, stores messages, calls the bridge as its provider.
- **bridge** — OpenAI-compatible endpoint; runs `claude -p --output-format stream-json`
  per turn, streams tool activity back to the app's Console, returns the final reply.
- **Claude Code CLI** — your real CLI: your subscription, your MCP servers, your config.

## What you get

- **Your Claude subscription** — the bridge runs the real CLI, so there is no separate API bill.
- **MCP tools** — the CLI loads your existing MCP servers; tool calls stream to the Console tab.
- **Session continuity** — one long-lived Claude Code session is resumed across turns.

## Known limitation: thinking blocks (v1)

The subscription CLI's **headless print mode** (`claude -p`) does **not** expose raw
chain-of-thought. Extended thinking still runs, but the stream carries only encrypted
thinking *signatures*, not the plaintext — so thinking blocks are not shown in this mode.
The Console tab shows live tool activity instead.

This is a platform behavior, not a bug in the bridge: the same subscription exposes
thinking in the *interactive* CLI, but not in headless `-p`. Restoring full thinking
without an API key is on the [roadmap](../README.md#roadmap): drive the CLI in interactive
mode and read the structured session transcript
(`~/.claude/projects/*/<session>.jsonl`), where interactive-mode thinking is plaintext.

## Prerequisites

- Node.js 18+.
- Claude Code CLI: `npm install -g @anthropic-ai/claude-code`, signed in to a Claude
  Pro/Max/Team subscription (`claude` should work in your terminal).

## Setup

### 1. Start the companion app

```bash
git clone https://github.com/tjing9430/cc-companion-app.git
cd cc-companion-app
cp .env.example .env
npm start
```

### 2. Point the app's provider at the bridge

In `.env`:

```bash
OPENAI_API_KEY=bridge                     # any non-empty value; the bridge ignores it
OPENAI_BASE_URL=http://127.0.0.1:8788/v1
OPENAI_MODEL=claude-code
```

`OPENAI_API_KEY` must be non-empty (an empty key makes the app use its built-in mock
agent), but its value is never used — the bridge authenticates to Claude via your CLI.

### 3. Start the bridge

In a second terminal, from the repo root:

```bash
npm run bridge
```

You should see `[bridge] info: listening on http://127.0.0.1:8788`. Send a message in the
app — it is forwarded to Claude Code, and the reply appears in the chat while tool calls
stream to the Console tab.

## Configuration

The bridge reads the same `.env` file. All variables have safe defaults:

| Variable | Default | Purpose |
|---|---|---|
| `BRIDGE_HOST` | `127.0.0.1` | Bind address. **Keep local** (see Security). |
| `BRIDGE_PORT` | `8788` | Bridge listen port (matches `OPENAI_BASE_URL`). |
| `APP_URL` | `http://127.0.0.1:8787` | Where the bridge posts live thinking/tool events. |
| `APP_AUTH_TOKEN` | *(empty)* | Reused to authenticate console posts if the app is protected. |
| `CLAUDE_BIN` | `claude` | Path to the Claude Code executable. |
| `CLAUDE_MODEL` | *(CLI default)* | Optional `--model` override. |
| `CLAUDE_MCP_CONFIG` | *(none)* | Optional `--mcp-config` file for extra MCP servers. |
| `BRIDGE_SESSION_MODE` | `resume` | `resume` (persist context) or `fresh` (new session per restart). |
| `BRIDGE_TIMEOUT_MS` | `300000` | Max time for a single Claude turn. |

## Session management

The bridge keeps **one** Claude Code session and resumes it (`claude -p --resume <id>`)
on every turn, so context persists across messages — and across bridge restarts.

- The active session id is stored in `<DATA_DIR>/bridge-session.json` (default `data/bridge-session.json`).
- On restart with `BRIDGE_SESSION_MODE=resume` (default), the bridge resumes the saved session.
- If the saved session is gone (deleted transcript, CLI upgrade), the bridge automatically
  starts a fresh session on the next turn.
- **To start a brand-new conversation:** stop the bridge and delete
  `data/bridge-session.json` (or set `BRIDGE_SESSION_MODE=fresh`), then start it again.

## Security

The bridge is an **unauthenticated proxy to your Claude subscription** — anyone who can
reach its port can spend your Claude usage. It binds to `127.0.0.1` by default.

- Do **not** set `BRIDGE_HOST=0.0.0.0` or expose the bridge port on a public interface.
- To use the app from your phone, expose the **app** (port 8787) behind auth + HTTPS
  (see [Access From Your Phone](../README.md#access-from-your-phone)), and keep the bridge local.
- The bridge logs a warning if it is bound to a non-local address.

## FAQ

**Can I use my subscription instead of an API key?**
Yes — that is the whole point. The bridge runs your logged-in Claude Code CLI, which uses
your subscription. Leave `ANTHROPIC_API_KEY` unset.

**Do my MCP tools work?**
Yes. The CLI loads your normal MCP configuration; tool calls appear in the Console tab as
they run. Use `CLAUDE_MCP_CONFIG` to add servers just for the bridge.

**Why don't I see thinking blocks?**
See [Known limitation](#known-limitation-thinking-blocks-v1) above — headless `-p` does not
expose raw thinking on a subscription. This is planned for v1.1.

**Does the chat reply stream token-by-token?**
No. The app stores each assistant message when it is complete (same as Mode 1), so the
chat bubble appears at once. Live progress (tool calls) streams to the Console tab during
generation.

**Does the app's system prompt / persona / history window apply?**
No. The bridge sends only your **latest user message** to Claude Code — the app-side
system prompt, memory notes, and chat-history window are ignored; the conversation context
is held by the Claude Code session itself (resumed each turn). If you set an assistant
persona in the app's Settings, it does **not** take effect in this mode — configure Claude
Code directly instead (`CLAUDE.md`, output styles, etc.). To avoid sending an unused
history window on every turn, you can set `CHAT_CONTEXT_MAX_MESSAGES=0` in `.env`.

**What about `/forge` and `/quota`?**
Those still use the optional external adapters described in the main README; the bridge
does not implement session rotation or quota reporting in v1.
