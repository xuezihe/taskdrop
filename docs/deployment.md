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
DATABASE_URL=postgres://db-user:db-password@127.0.0.1:5432/taskdrop \
node dist/production/main.js
```

The runtime listens on `127.0.0.1:3000` and handles:

| Path      | Purpose                   |
| --------- | ------------------------- |
| `/health` | Health probe              |
| `/mcp`    | Remote MCP (Streamable)   |
| `/api/*`  | Browser API (Bearer auth) |

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

This value is read by Vite at build time, not by the running Node process. Set
it while running `pnpm build:web` or `pnpm verify` whenever the deployed MCP
origin differs from the default:

```bash
TASKDROP_MCP_ORIGIN=https://taskdrop.example.com pnpm verify
```

Changing the environment of an already-built `dist/landing` does not update
the displayed MCP configuration. Rebuild and republish the Web artifact.

## Production artifact location

Running Caddy as a system service is different from running `caddy` in the
repository root. A service-owned Caddy process normally cannot traverse a
checkout under `/root`, and a relative `dist/landing` root is resolved in the
wrong working directory.

For the documented Debian single-server deployment, publish each Web build to
a release directory under `/var/www/taskdrop/releases/` and point
`/var/www/taskdrop/current` at the active release. Keep the Node build and Web
release tied to the same Git commit. The exact commands and permissions are in
[`deploy/server/DEPLOY.md`](../deploy/server/DEPLOY.md).

## Release verification

After starting the runtime and Caddy, verify the deployment from the same
browser-visible origin:

```bash
curl --fail-with-body https://taskdrop.example.com/health
```

Open `/handoff/<code>` as a top-level document and confirm that the Workspace
loads through the SPA fallback, Browser API requests stay relative to the
current origin, and the Remote MCP endpoint still responds at its configured
origin. Supply the Space Key out of band; do not put it in commands, URLs,
screenshots, logs, or release notes.

The public release smoke must discover and invoke all five page-scoped tools in
the ChatGPT Desktop built-in browser, then complete:

```text
Remote MCP Revision N
        -> WebMCP updates the visible Working Draft
        -> WebMCP commits Revision N+1
        -> Remote MCP reads Revision N+1 as latest
```

Chrome is an auxiliary compatibility check and does not replace the primary
runtime. Run the public deployment smoke and Remote MCP read-back against the
deployed HTTPS origin before considering a release verified.

Also inspect the deployed response policies in the primary runtime. WebMCP is
subject to browser security requirements, including the `tools` Permissions
Policy. Do not add a policy that disables the capability for the top-level
Workspace, and verify current browser requirements against the official WebMCP
sources before changing security headers.

## Rollback

Keep the previous Node artifact and published Web release until the new release
has passed health, route, and primary acceptance checks. Application rollback
is then:

1. Stop the new Node runtime.
2. Restore the previous application artifact and its environment configuration.
3. Start the previous Node runtime on the same loopback port; Caddy can remain
   in place if its routing has not changed.
4. Switch the Web artifact to the release built from the same known-good
   commit.
5. Re-run the health, top-level Workspace, same-origin Browser API, Remote MCP,
   and primary WebMCP checks above.

The migration runner records applied versions and only applies pending SQL
files. It has no automatic down-migration path. Do not run an older binary
against a schema it cannot support or invent a reverse migration during an
incident. If a schema rollback is required, stop the service and restore the
operator-approved PostgreSQL backup according to the deployment runbook, then
repeat the verification checks.

Never include `DATABASE_URL`, a Space Key, `localSpaceId`, or complete Handoff
Markdown in rollback notes or acceptance evidence.
