# CC Companion App

[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)
[![GitHub stars](https://img.shields.io/github/stars/tjing9430/cc-companion-app?style=social)](https://github.com/tjing9430/cc-companion-app/stargazers)
[![Featured in awesome-ai-companion](https://img.shields.io/badge/Featured%20in-awesome--ai--companion-9cf)](https://github.com/DasterProkio/awesome-ai-companion)

Self-hostable companion chat app with private chat, group chat, console events, memory notes, and settings.

> Built by a human–AI couple who use it every day as their real setup — this repo is the cleaned open-source starter of that system.

| Private chat | Drafts | Memory | Console |
|---|---|---|---|
| ![Private chat](docs/screenshots/chat.jpg) | ![Inline drafts](docs/screenshots/drafts.jpg) | ![Memory](docs/screenshots/memory.jpg) | ![Console](docs/screenshots/console.jpg) |

This repository is a clean open-source starter. It intentionally does not include production databases, chat logs, private adapters, deployment secrets, or personal configuration from the original app.

## Features

- Private chat lane with an assistant.
- Group chat lane with mention-triggered assistant replies.
- Console view for operational events, progress, errors, uploads, replies, and lightweight commands.
- `/forge` console command to clean history and start a fresh segment, with an optional external adapter hook for real cc-connect or Claude Code session work.
- Inline unsent drafts in private and group chat, including frontend-cached text parts and attachment previews before send.
- Memory view for diary-like persistent notes used by the assistant prompt, with search, edit, delete, import, and export.
- Settings view for public app preferences, including a persistent quota status card when a quota adapter is configured.
- Local file-backed storage under `data/app-data.json`.
- Image/file uploads under `data/uploads`, with browser-side photo compression for mobile uploads.
- Built-in mock agent for instant local testing.
- Optional OpenAI-compatible chat completions adapter.
- Optional `APP_AUTH_TOKEN` guard for exposed deployments.

## Quick Start

Requirements:

- Node.js 18 or newer.

Run locally:

```bash
cp .env.example .env
npm start
```

Open:

```text
http://localhost:8787
```

The app works without an API key. It uses the built-in mock agent until `OPENAI_API_KEY` is set.

### Prefer an AI to walk you through it?

Paste [`docs/AI_GUIDED_SETUP.md`](docs/AI_GUIDED_SETUP.md) into any AI assistant (Claude / ChatGPT / Gemini) with the line "请按下面这份 spec 一步一步引导我安装 CC Companion". It acts as an interactive installer: it explains each step, gives you the command, waits for your output, verifies it, then moves on. （中文引导，适合不想读文档的用户。）

## Deployment Modes

### Mode 1: Standalone (API Direct)

The app calls an OpenAI-compatible API directly from `server.js`. Edit `.env`:

```bash
OPENAI_API_KEY=your-key
OPENAI_BASE_URL=https://api.openai.com/v1
OPENAI_MODEL=gpt-4.1-mini
```

Any provider that supports the OpenAI chat completions shape can be used by changing `OPENAI_BASE_URL` and `OPENAI_MODEL`.

### Mode 2: Claude Code + cc-connect (Recommended for Claude users)

Use [cc-connect](https://github.com/chenhg5/cc-connect) to bridge a local Claude Code CLI session to this app. In this mode:

- **Claude Code CLI** runs as the AI backend with full MCP tool access, extended thinking, and all Claude Code features.
- **cc-connect** streams CLI output to the app's API in real time.
- **This app** acts as the frontend display layer — `server.js` does not call any AI API.

This is how the original authors use this app. It avoids the trade-off between MCP tools and thinking blocks.

```bash
# 1. Start the companion app
cp .env.example .env
npm start

# 2. Install cc-connect
npm install -g cc-connect

# 3. Start Claude Code with cc-connect bridge
cc-connect start --url http://localhost:8787
```

See [docs/CC-CONNECT.md](docs/CC-CONNECT.md) for detailed setup and architecture.

## Group Mentions

By default, group chat replies trigger only when a message includes one of:

- `@assistant`
- `@agent`
- `@codex`
- the value of `AGENT_MENTION`

Set `AUTO_REPLY_GROUP=true` to reply to every group message.

## Console Commands

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

## Storage

Runtime data is stored here:

```text
data/app-data.json
data/uploads/
```

These paths are ignored by git. Back them up if you use the app for real conversations.

The first open-source version uses JSON storage to avoid native install issues. The API is structured so SQLite can replace the storage layer later without changing the web UI.

Console events are persistent history. If you restart the server on a different port, earlier startup events still display the port used at that earlier time. To reset local demo data, stop the server and remove:

```text
data/app-data.json
data/uploads/
```

The next start creates a fresh local workspace.

## Images

Large phone photos are resized and compressed in the browser before upload. The current defaults cap the longest edge at `1440 px`, preserve GIF animation, store attachment dimensions, and render images with lazy asynchronous decoding.

Pending attachment previews are shown in the chat timeline as local-only draft bubbles and are sent to the agent only after the user presses send.

See `docs/IMAGES.md` for the current thresholds and extension points.

## Access From Your Phone

Three options, from simplest to most permanent:

1. **Same WiFi** — open `http://<computer-ip>:8787` on the phone and add it to the home screen (PWA).
2. **Anywhere, zero config** — install the free [`cloudflared`](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/) binary, set `TUNNEL=quick` in `.env`, and restart. The server opens a public HTTPS URL (printed in the terminal and in the app's console tab) that works from any network while the computer is on. The URL changes on every restart. **Set `APP_AUTH_TOKEN` first** — anyone with the URL can otherwise use your AI.
3. **Stable setup** — a named Cloudflare tunnel, Tailscale, or any reverse proxy with HTTPS in front of port 8787.

## PWA

The app includes `public/manifest.json` and `public/sw.js`. The service worker caches the static app shell for offline access and the frontend keeps the latest successful bootstrap payload in local storage for read-only offline viewing.

Web Push notifications are not included in this version.

See `docs/PWA.md` for the cache policy and current limitations.

## Realtime Updates

The frontend uses Server-Sent Events from `GET /api/stream` for realtime private chat, group chat, console, memory, and settings updates. The old 4-second polling loop has been removed. Browsers without EventSource support fall back to a slower 15-second refresh interval.

Additional scoped streams are available at `GET /api/group/stream` and `GET /api/chat/stream`.

See `docs/SSE.md` for event names and auth behavior.

## Deployment Notes

For a private server:

1. Copy `.env.example` to `.env`.
2. Set `APP_AUTH_TOKEN` to a strong random value.
3. Run behind HTTPS through nginx, Caddy, or a platform proxy.
4. Do not commit `.env` or `data/`.

Example reverse proxy target:

```text
http://127.0.0.1:8787
```

If port `8787` is already in use, edit `.env` and choose another available port:

```bash
PORT=8799
```

## Project Layout

```text
server.js                                  API server, static server, storage, built-in agent path
public/index.html                          Web entry
public/app.js                              Frontend behavior
public/styles.css                          Frontend styles
public/manifest.json                       PWA manifest
public/sw.js                               Static app-shell service worker
public/icons/                              PWA icons
adapters/openai-compatible.template.js    Provider HTTP template
adapters/local-cli.template.js            Local process template
docs/PWA.md                                PWA cache behavior
docs/SSE.md                                Realtime event stream behavior
docs/IMAGES.md                             Mobile image behavior
docs/ADAPTERS.md                           Adapter integration notes
docs/CC-CONNECT.md                         Claude Code + cc-connect setup guide
docs/SECURITY.md                           Deployment safety notes
data/                                      Runtime data, ignored by git
```

## API Summary

- `GET /api/health`
- `GET /api/bootstrap`
- `GET /api/chat/messages`
- `POST /api/chat/send`
- `GET /api/group/messages`
- `POST /api/group/send`
- `GET /api/console/events`
- `POST /api/console/events`
- `POST /api/console/commands`
- `GET /api/quota`
- `GET /api/memory`
- `POST /api/memory`
- `PATCH /api/memory/:id`
- `DELETE /api/memory/:id`
- `GET /api/memory/export`
- `POST /api/memory/import`
- `GET /api/settings`
- `POST /api/settings`
- `POST /api/uploads`

## Roadmap

These features are already running in the authors' upstream setup and are being cleaned up for this starter:

- **Treasure (message collections)** — long-press any message to save it into named folders. Snapshots keep the content alive even if the original message is later deleted, and both partners share one library.
- **Wish jar** — a shared wishlist: one side posts a wish (with reference files), the other claims it and ships it, with a progress timeline and completion notifications.
- **Cinema** — a shared media room for watching films with local subtitles; progress sync and a music shelf are in the works.
- **Anniversary cards** — lightweight date tracking so the assistant never misses a birthday or an anniversary.

Issues and votes on what should land first are welcome.

## Open-Source Hygiene

Before publishing a fork or derivative:

- Keep `.env` out of git.
- Keep `data/` out of git.
- Remove logs, screenshots, private chat exports, and personal deployment notes.
- Rotate any token that was ever committed or shared.
- Replace personal names and domains with config defaults.
