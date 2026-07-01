# SSE Realtime Updates

The app uses Server-Sent Events for realtime UI updates.

## Endpoints

- `GET /api/stream`: unified stream for private chat, group chat, console, memory, and settings.
- `GET /api/group/stream`: group-message-only stream.
- `GET /api/chat/stream`: private-message-only stream.

When `APP_AUTH_TOKEN` is enabled, EventSource clients can pass it as:

```text
/api/stream?token=...
```

Header-based auth is still used for normal JSON API requests.

## Events

- `ready`: stream connected.
- `snapshot`: latest visible state.
- `message`: new private or group message.
- `console`: new console event.
- `memory`: memory create/update/delete.
- `settings`: public settings changed.
- `ping`: keepalive.

## Frontend Behavior

The frontend opens `/api/stream` after bootstrap. Incoming events update local state directly and refresh the local offline snapshot.

The old 4-second polling loop is removed. Browsers without EventSource support fall back to a 15-second refresh interval.

## PWA Interaction

The service worker does not cache `/api/*`, including SSE routes. Offline mode displays the latest bootstrap snapshot and disables writes until the server is reachable again.
