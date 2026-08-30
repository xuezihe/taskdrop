# TaskDrop Deployment

This document describes how to deploy the TaskDrop Workspace so the Handoff UI
and Browser API share the same browser-visible origin.

## Prerequisites

- Node.js 24
- PostgreSQL 18
- Caddy (or another reverse proxy that can serve static files and proxy HTTP)
- A DNS record pointing the public domain to the deployment host

## Build

```bash
pnpm install
pnpm build
pnpm build:web
pnpm migrate   # requires DATABASE_URL
```

`pnpm build` compiles the Node runtime into `dist/production/`.
`pnpm build:web` produces the static Workspace in `dist/landing/`.

## Node runtime

Start the production server:

```bash
PORT=3000 \
DATABASE_URL=postgres://taskdrop:REPLACE_WITH_PASSWORD@127.0.0.1:5432/taskdrop \
node dist/production/main.js
```

The runtime listens on `127.0.0.1:3000` and handles:

| Path       | Purpose                    |
| ---------- | -------------------------- |
| `/health`  | Health probe               |
| `/mcp`     | Remote MCP (Streamable)    |
| `/api/*`   | Browser API (Bearer auth)  |

## Caddy reverse proxy

Copy the example Caddyfile and adjust it for the deployment domain:

```bash
cp Caddyfile.example Caddyfile
```

Edit `Caddyfile` to set the public domain or use environment variables:

```bash
TASKDROP_DOMAIN=taskdrop.example.com \
TASKDROP_PORT=3000 \
TASKDROP_WEB_ROOT=dist/landing \
caddy run
```

Caddy handles TLS, serves the static Workspace at `/`, and proxies `/api/*`,
`/mcp`, and `/health` to the Node runtime. This ensures the Handoff UI and
Browser API share the same browser-visible origin with no cross-origin API
contract.

## Same-origin requirement

The Handoff Workspace makes same-origin `fetch` calls to `/api/*`. The Browser
API does not define a CORS contract. Both the static files and the API must be
served from the same scheme, host, and port as seen by the browser.

## Local development

During local development, Vite proxies `/api/*` to the Node runtime:

```bash
# Terminal 1: start the Node runtime
PORT=3000 DATABASE_URL=postgres://... node dist/production/main.js

# Terminal 2: start the Vite dev server
pnpm dev:web
```

The Vite proxy target defaults to `http://127.0.0.1:3000` and can be overridden
with `TASKDROP_BROWSER_API_TARGET`.

## Remote MCP origin

The Remote MCP endpoint can remain on a separate public origin if needed. The
`TASKDROP_MCP_ORIGIN` environment variable (or `VITE_TASKDROP_MCP_ORIGIN`)
controls the MCP config snippets shown on the landing page. It defaults to
`https://taskdrop.xuezihe.com`.
