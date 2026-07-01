# PWA Support

The app includes a minimal PWA layer:

- `public/manifest.json`
- `public/sw.js`
- SVG app icons under `public/icons/`

## What Is Cached

The service worker caches the static app shell:

- `/`
- `/index.html`
- `/styles.css`
- `/app.js`
- `/manifest.json`
- `/icons/app-icon.svg`
- `/icons/maskable-icon.svg`

Navigation requests fall back to cached `index.html` when offline.

## What Is Not Cached

API routes and uploaded files are not cached by the service worker:

- `/api/*`
- `/uploads/*`

The frontend stores the latest successful bootstrap payload in local storage. When offline, the app shell opens with that snapshot so private chat, group chat, console, memory, and settings remain readable. Sending messages and uploading files stay disabled until the server is reachable again.

## Web Push

Web Push is intentionally not included in this version. Add it later as a separate feature so notification permissions, VAPID keys, and server-side push queues can be reviewed independently.
