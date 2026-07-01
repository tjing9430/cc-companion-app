# Security Notes

This app is designed for self-hosting. Treat it as a private application unless you add production-grade authentication and rate limiting.

## Defaults

- No authentication is enabled unless `APP_AUTH_TOKEN` is set.
- Runtime data is stored locally under `data/`.
- Uploaded files are served from `/uploads/`.
- The mock agent is enabled when no API key is configured.

## Before Exposing To The Internet

Set:

```bash
APP_AUTH_TOKEN=replace-with-a-long-random-token
```

Use HTTPS through a reverse proxy and keep the Node process bound behind that proxy.

Do not commit:

- `.env`
- `data/app-data.json`
- `data/uploads/`
- logs
- real chat exports
- production deployment scripts

## Agent Keys

Provider keys are read only from environment variables. They are never sent to the browser by the built-in server.

