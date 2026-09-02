# TaskDrop single-server public deployment

This is the production path for the public TaskDrop Handoff Workspace and
Remote MCP endpoint on one Debian VPS:

```text
Internet -> Cloudflare -> Caddy on the host
                         |              |
                         |              +-> static Workspace release
                         |                  /var/www/taskdrop/current
                         v
                   TaskDrop Node on 127.0.0.1:3000
                         |
                         v
                   PostgreSQL in Docker
                     on 127.0.0.1:5432
                         |
                         v
                    named Docker volume
```

TaskDrop runs as built JavaScript under `nohup`. PostgreSQL is the only
containerized component. Caddy terminates HTTPS, serves the Vite-built
Workspace, and proxies `/api/*`, `/mcp`, and `/health`. Ports 3000 and 5432 stay
on loopback. `nohup` does not provide boot startup, a dedicated service
identity, or automatic crash recovery; moving the Application to systemd
remains later hardening.

The commands assume a root shell and an existing `dev` checkout at
`/root/Proj/taskDrop`. Replace `<TASKDROP_PUBLIC_HOST>` with the public HTTPS
hostname. The documented topology serves the Workspace, Browser API, and
Remote MCP from that hostname. Do not paste real credentials into this guide,
shell arguments, tickets, or chat.

Set the public hostname once in each operator shell before using the command
examples:

```bash
taskdrop_public_host=taskdrop.example.com
```

## 1. Prepare the host and DNS

Install the following from their official Debian instructions:

- Node.js 24 at `/usr/bin/node`
- pnpm 10.13.x
- Docker Engine with the Compose plugin
- Caddy
- Git and OpenSSL

Confirm the environment:

```bash
cd /root/Proj/taskDrop
git branch --show-current
git rev-parse HEAD
node --version
pnpm --version
command -v node
command -v pnpm
docker --version
docker compose version
caddy version
```

The branch must be `dev`, Node.js must be 24.x, pnpm must be 10.13.x, and Node
must resolve to `/usr/bin/node` for the commands below.

Create proxied Cloudflare DNS records for the public hostname. An IPv6-only
origin can use a proxied `AAAA` record; Cloudflare supplies the public IPv4/IPv6
edge. Keep SSL/TLS at Full while Caddy obtains the origin certificate, then use
Full (strict). For the public hostname:

- disable Browser Integrity Check and browser challenges;
- bypass Cloudflare cache for `/api/*`, `/mcp`, and `/health`;
- keep the DNS record proxied;
- do not redirect `/mcp` to another hostname or path.

Static fingerprinted assets may use normal cache rules, but `/index.html` and
SPA fallback responses must revalidate so a release does not leave clients on
an old HTML shell. Inspect any response `Permissions-Policy`; do not deploy a
policy that disables WebMCP `tools` for the top-level Workspace. Verify current
WebMCP browser-policy requirements against the official sources before adding
or changing that header.

## 2. Create protected environment files

Generate one URI-safe PostgreSQL password without printing it or placing the
value in shell history:

```bash
install -d -o root -g root -m 0700 /etc/taskdrop
sh -eu -c '
umask 077
password="$(openssl rand -hex 32)"
printf "%s\n" \
  "POSTGRES_USER=taskdrop" \
  "POSTGRES_DB=taskdrop" \
  "POSTGRES_PASSWORD=$password" \
  > /etc/taskdrop/postgres.env
printf "%s\n" \
  "PORT=3000" \
  "DATABASE_URL=postgresql://taskdrop:$password@127.0.0.1:5432/taskdrop" \
  "RETENTION_WINDOW_MS=604800000" \
  "LOG_LEVEL=info" \
  > /etc/taskdrop/taskdrop.env
chmod 0600 /etc/taskdrop/postgres.env /etc/taskdrop/taskdrop.env
unset password
'
```

The example files beside this guide document the required names. Never use
their placeholder password in a deployment. `RETENTION_WINDOW_MS=604800000`
is seven days; Production accepts one hour through 30 days. Before a public
Challenge release, choose a window that keeps disposable judge Handoffs usable
for the intended judging period, without exceeding the supported maximum.
Document the chosen duration, and do not imply that a read extends it: only a
successful Revision append refreshes retention.

## 3. Start PostgreSQL

From the repository root:

```bash
cd /root/Proj/taskDrop
docker compose -f deploy/server/compose.yml up -d
docker compose -f deploy/server/compose.yml ps
```

Wait for `postgres` to report healthy. The Compose file publishes PostgreSQL
only on `127.0.0.1:5432` and stores data in the named
`taskdrop_taskdrop-postgres-data` volume. `docker compose down` preserves the
volume. Do not use `down --volumes` on retained data.

## 4. Install, verify, build, migrate, and publish the Workspace

```bash
cd /root/Proj/taskDrop
pnpm install --frozen-lockfile
TASKDROP_MCP_ORIGIN="https://$taskdrop_public_host" pnpm verify
```

`pnpm verify` builds both `dist/production/` and `dist/landing/`. The MCP origin
is embedded into the Web artifact by Vite at build time. Confirm both outputs:

```bash
test -f dist/production/main.js
test -f dist/production/migrate.js
test -f dist/production/admin-cli.js
test -f dist/landing/index.html
```

Apply migrations explicitly before first startup and before restarting an
updated build:

```bash
cd /root/Proj/taskDrop
set -a
. /etc/taskdrop/taskdrop.env
set +a
/usr/bin/node dist/production/migrate.js
unset DATABASE_URL PORT RETENTION_WINDOW_MS LOG_LEVEL
```

Stop if migration exits non-zero. Application startup never modifies the
schema automatically.

Publish the static build outside `/root` so the system Caddy user can read it.
Use one immutable directory per Git commit, then atomically switch the
`current` symlink:

```bash
cd /root/Proj/taskDrop
release_id="$(git rev-parse --short=12 HEAD)"
web_release="/var/www/taskdrop/releases/$release_id"
test ! -e "$web_release"
install -d -o root -g caddy -m 0750 /var/www/taskdrop
install -d -o root -g caddy -m 0750 /var/www/taskdrop/releases
install -d -o root -g caddy -m 0750 "$web_release"
cp -a dist/landing/. "$web_release/"
chown -R root:caddy "$web_release"
find "$web_release" -type d -exec chmod 0750 {} +
find "$web_release" -type f -exec chmod 0640 {} +
ln -s "$web_release" /var/www/taskdrop/current.next
mv -Tf /var/www/taskdrop/current.next /var/www/taskdrop/current
readlink -f /var/www/taskdrop/current
unset release_id web_release
```

Do not point the Caddy system service directly at
`/root/Proj/taskDrop/dist/landing`: the service normally cannot traverse
`/root`, and an in-place rebuild would make rollback ambiguous. Retain at least
the current and previous Web release directories until acceptance passes.

## 5. Start the Application with nohup

Confirm no process already owns the Application port:

```bash
ss -lntp | grep ':3000' || true
```

Create the log directory, load the protected environment, and capture the PID
from the same shell that starts Node:

```bash
install -d -o root -g root -m 0750 /var/log/taskdrop
cd /root/Proj/taskDrop
set -a
. /etc/taskdrop/taskdrop.env
set +a
nohup /usr/bin/node dist/production/main.js \
  >> /var/log/taskdrop/application.log \
  2>&1 \
  </dev/null &
taskdrop_pid=$!
printf '%s\n' "$taskdrop_pid" > /run/taskdrop-application.pid
unset taskdrop_pid DATABASE_URL PORT RETENTION_WINDOW_MS LOG_LEVEL
```

Verify the process, listener, startup log, and loopback health:

```bash
cat /run/taskdrop-application.pid
ps -fp "$(cat /run/taskdrop-application.pid)"
ss -lntp | grep ':3000'
tail -n 30 /var/log/taskdrop/application.log
curl --fail --silent --show-error http://127.0.0.1:3000/health
```

Expected health body:

```json
{ "status": "ok" }
```

The first cleanup pass starts asynchronously after the listener is ready. A
successful observation looks like this and contains no Handoff content:

```json
{ "operation": "cleanup_expired_handoffs", "deletedHandoffs": 0, "durationMs": 100 }
```

## 6. Configure Caddy

Add this site block to `/etc/caddy/Caddyfile`, replacing
`<TASKDROP_PUBLIC_HOST>`:

```caddyfile
<TASKDROP_PUBLIC_HOST> {
        handle /api/* {
                reverse_proxy 127.0.0.1:3000
        }

        handle /mcp {
                reverse_proxy 127.0.0.1:3000
        }

        handle /health {
                reverse_proxy 127.0.0.1:3000
        }

        handle {
                root * /var/www/taskdrop/current
                try_files {path} /index.html
                file_server
        }
}
```

The proxy handlers perform no prefix stripping, rewrite, or redirect, so the
method, query, body, and Authorization header reach TaskDrop unchanged. The
final handler serves real static files and falls back to `/index.html`, which
makes `/handoff/:code` a top-level SPA route. Do not use `handle_path` for
`/api/*`; it would strip the prefix expected by the Node Browser API.

Do not enable a Caddy access log or debug log for the public hostname. A Query
carrier places the Space Key in the request URL. If the shared Caddy instance
has request logging from another configuration, ensure this host and
request-scoped errors are excluded before using Query authentication.

Validate and reload:

```bash
caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
systemctl reload caddy
systemctl status caddy --no-pager
```

Verify public behavior:

```bash
curl --fail --silent --show-error "https://$taskdrop_public_host/health"
curl --fail --silent --show-error "https://$taskdrop_public_host/" \
  --output /dev/null
curl --fail --silent --show-error \
  "https://$taskdrop_public_host/handoff/ABC123" \
  --output /dev/null
browser_api_status="$(curl --silent --output /dev/null --write-out '%{http_code}' \
  "https://$taskdrop_public_host/api/handoffs/ABC123")"
test "$browser_api_status" = 401
unset browser_api_status
```

Health must return `{"status":"ok"}`; `/` and the disposable
`/handoff/ABC123` route must return the Workspace HTML rather than 404. The
unauthenticated Browser API probe must return 401, proving that `/api/*` reached
the Node credential boundary instead of the SPA fallback. Do not use a real
Handoff Code in retained deployment output.

If normal CLI requests receive 403 while a browser succeeds, check Cloudflare
Browser Integrity Check or challenge rules for this hostname.

## 7. Verify the deployment boundary

On the VPS, both internal listeners must be loopback-only:

```bash
ss -lntp | grep ':3000'
ss -lntp | grep ':5432'
ss -lntp | grep -E ':(80|443)\b'
```

From another machine, verify public HTTPS and confirm ports 3000 and 5432 are
not reachable through the VPS public addresses. Never include a Space Key in a
connectivity diagnostic shared with someone else.

Configure Remote MCP clients using the generated Bearer field first. Verify
create -> get latest -> append -> get latest, then send `SIGTERM` and restart
the Application using the procedures in [RUNBOOK.md](./RUNBOOK.md). Read the
same live Handoff again after restart.

From the public top-level `/handoff/:code` page, confirm that Browser API calls
remain relative to the public origin and that the Human read, edit, Discard,
and Commit path works even if WebMCP is unavailable. Browser API requests use a
Bearer Space Key; never place the key in the Handoff URL.

Finally, use the ChatGPT Desktop built-in browser against the public HTTPS URL:

1. discover and invoke `get_handoff_context`, `get_revision_history`,
   `read_revision`, `update_working_draft`, and `commit_working_draft`;
2. confirm the WebMCP update appears immediately in the visible editor;
3. complete Remote MCP Revision N -> WebMCP Draft -> Commit Revision N+1 ->
   Remote MCP latest read;
4. confirm no Space Key or `localSpaceId` appears in tool schemas, results,
   URLs, Markdown, screenshots, or retained logs.

Chrome is an auxiliary compatibility check and cannot replace this primary
runtime smoke.

## 8. Record acceptance

Record only:

- date and deployed Git commit;
- Node.js, PostgreSQL, Docker, and Caddy versions;
- active Node and Web release commit;
- pass/fail for migration, HTTPS, Workspace and SPA routes, same-origin Browser
  API, Remote MCP, loopback isolation, both credential carriers, Handoff restart
  persistence, Admin inspection, cleanup, database persistence, retained-log
  inspection, five-tool discovery, and the public Remote MCP/WebMCP loop.

Never record a Space Key, Handoff Code, Markdown, database URL, Authorization
value, credential-bearing Query URL, or complete client configuration. Continue
with the Operator acceptance commands in [RUNBOOK.md](./RUNBOOK.md).
