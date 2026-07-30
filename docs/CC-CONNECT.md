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
┌──────────────┐   POST /v1/chat/completions   ┌──────────────┐  types msg   ┌──────────────────┐
│  Companion    │ ────────────────────────────▶ │    bridge     │ ─(pty)─────▶ │  claude           │
│  App (8787)   │ ◀──── reply + thinking ─────── │   (8788)      │ ◀─ reads ─── │  (interactive):   │
└──────┬───────┘                                └──────┬───────┘   transcript  │  sub + MCP + CoT  │
       │  POST /api/console/events (thinking + tools)  │            jsonl      └──────────────────┘
       └───────────────────────────────────────────────┘
```

- **Companion App** — serves the UI, stores messages, calls the bridge as its provider.
- **bridge** — OpenAI-compatible endpoint. In the default `interactive` mode it types your
  message into a real interactive CLI (in a pty) and reads the session transcript jsonl, so
  extended thinking is captured; in `print` mode it runs `claude -p` (no thinking). Either way
  it streams thinking/tool activity to the Console and returns the final reply. See
  [Modes](#modes-interactive-default-vs-print).
- **Claude Code CLI** — your real CLI: your subscription, your MCP servers, your config.

## What you get

- **Your Claude subscription** — the bridge runs the real CLI, so there is no separate API bill.
- **MCP tools** — the CLI loads your existing MCP servers; tool calls stream to the Console tab.
- **Extended thinking** — the default interactive mode reads the transcript, so thinking blocks show in chat + Console (Linux/WSL).
- **Session continuity** — one long-lived Claude Code session is resumed across turns.

## Modes: interactive (default) vs print

Set `BRIDGE_MODE`:

- **`interactive`** (default, **Linux/WSL only**): drives a real interactive Claude Code
  CLI inside a pseudo-tty (via util-linux `script`) and reads the session transcript jsonl.
  The interactive CLI exposes **plaintext extended thinking** in the transcript, so thinking
  blocks appear in chat (`reasoning_content`) and stream to the Console. The terminal is
  treated as a dumb pipe — the bridge only types your message into it and reads all content
  (thinking, reply, tool calls) from the transcript, never by scraping the screen.
- **`print`**: headless `claude -p` (the v1 path) — faster and cross-platform, but the
  subscription CLI redacts thinking in print mode (only encrypted signatures come back), so
  no thinking blocks are shown; the Console shows tool activity instead.

Why two modes? On a subscription, plaintext chain-of-thought is exposed by the *interactive*
CLI but not by headless `-p` — a platform behavior, not a bridge choice. Interactive mode
works around it by reading the transcript. `node-pty` for macOS/Windows interactive support
is on the [roadmap](../README.md#roadmap) (v1.2); until then, non-Linux users can use `print` mode.

### Tool permissions (interactive mode)

The interactive CLI asks for confirmation before running tools that aren't pre-approved.
The bridge does **not** bypass this (it never enables `--dangerously-skip-permissions`).
Pre-approve your tools by running `claude` once in the same directory and accepting the
allowlist, or set `BRIDGE_PERMISSION_MODE` (passed through as `claude --permission-mode`,
e.g. `plan` / `acceptEdits` / `default`). If a turn stalls waiting for an unapproved tool,
the bridge posts a Console note ("possibly waiting for a permission prompt — check the
terminal") instead of hanging silently, and the turn eventually times out (the session
stays alive for the next turn).

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
| `BRIDGE_MODE` | `interactive` | `interactive` (reads transcript → thinking; Linux/WSL) or `print` (headless `-p`; no thinking; cross-platform). |
| `BRIDGE_PERMISSION_MODE` | *(empty)* | Interactive only: passed as `claude --permission-mode` (e.g. `plan` / `acceptEdits`). Empty = use your existing config. |
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

The bridge keeps **one** Claude Code session and resumes it (`--resume <id>`) on every
turn, so context persists across messages — and across bridge restarts.

- The active session id is stored under `<DATA_DIR>/`: `bridge-session-interactive.json`
  for interactive mode, `bridge-session.json` for print mode.
- Interactive mode always resumes its persisted session across restarts; if the CLI process
  crashes mid-conversation, the next turn transparently respawns with `--resume` (context intact).
- Print mode honors `BRIDGE_SESSION_MODE` (`resume` persists / `fresh` starts new each restart).
- If the saved session is gone (deleted transcript, CLI upgrade), the bridge automatically
  starts a fresh session on the next turn.
- **To start a brand-new conversation:** stop the bridge and delete that session file, then start again.

## Security

The bridge is an **unauthenticated proxy to your Claude subscription** — anyone who can
reach its port can spend your Claude usage. It binds to `127.0.0.1` by default.

- Do **not** set `BRIDGE_HOST=0.0.0.0` or expose the bridge port on a public interface.
- To use the app from your phone, expose the **app** (port 8787) behind auth + HTTPS
  (see [Install It On Your Phone](../README.md#install-it-on-your-phone)), and keep the bridge local.
- The bridge logs a warning if it is bound to a non-local address.

## FAQ

**Can I use my subscription instead of an API key?**
Yes — that is the whole point. The bridge runs your logged-in Claude Code CLI, which uses
your subscription. Leave `ANTHROPIC_API_KEY` unset.

**Do my MCP tools work?**
Yes. The CLI loads your normal MCP configuration; tool calls appear in the Console tab as
they run. Use `CLAUDE_MCP_CONFIG` to add servers just for the bridge.

**Why don't I see thinking blocks?**
Thinking shows in the default `interactive` mode (Linux/WSL). If it's missing, you're likely
in `print` mode (`BRIDGE_MODE=print`, which redacts thinking on a subscription) or on a
platform where interactive mode isn't supported yet (macOS/Windows — see the
[roadmap](../README.md#roadmap)). Note thinking is also model-driven: simple prompts may not
trigger extended thinking at all.

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
