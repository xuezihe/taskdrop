# TaskDrop single-server dogfood deployment

This is the M3 deployment path exercised on one Debian VPS:

```text
Internet -> Cloudflare -> Caddy on the host -> TaskDrop on 127.0.0.1:3000
                                                   |
                                                   v
                                         PostgreSQL in Docker
                                           on 127.0.0.1:5432
                                                   |
                                                   v
                                          named Docker volume
```

TaskDrop runs as built JavaScript under `nohup`. PostgreSQL is the only
containerized component. Caddy terminates HTTPS. Ports 3000 and 5432 stay on
loopback. This is a private dogfood deployment: `nohup` does not provide boot
startup, a dedicated service identity, or automatic crash recovery. Moving the
Application to systemd is later deployment hardening, not part of this path.

The commands assume a root shell and an existing `dev` checkout at
`/root/Proj/taskDrop`. Replace `<TASKDROP_MCP_HOST>` with the MCP hostname. Do
not paste real credentials into this guide, shell arguments, tickets, or chat.

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

Create proxied Cloudflare DNS records for the MCP hostname. An IPv6-only origin
can use a proxied `AAAA` record; Cloudflare supplies the public IPv4/IPv6 edge.
Keep SSL/TLS at Full while Caddy obtains the origin certificate, then use Full
(strict). For the MCP hostname:

- disable Browser Integrity Check and browser challenges;
- bypass Cloudflare cache;
- keep the DNS record proxied;
- do not redirect `/mcp` to another hostname or path.

The landing-page hostname may use different caching and browser-security rules.

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
is seven days; Production accepts one hour through 30 days.

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

## 4. Install, verify, build, and migrate

```bash
cd /root/Proj/taskDrop
pnpm install --frozen-lockfile
pnpm verify
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
schema automatically. Confirm the production entry points exist:

```bash
test -f dist/production/main.js
test -f dist/production/migrate.js
test -f dist/production/admin-cli.js
```

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
{"status":"ok"}
```

The first cleanup pass starts asynchronously after the listener is ready. A
successful observation looks like this and contains no Handoff content:

```json
{"operation":"cleanup_expired_handoffs","deletedHandoffs":0,"durationMs":100}
```

## 6. Configure Caddy

Add this site block to `/etc/caddy/Caddyfile`, replacing
`<TASKDROP_MCP_HOST>`:

```caddyfile
<TASKDROP_MCP_HOST> {
        route {
                @taskdrop path /mcp /health
                reverse_proxy @taskdrop 127.0.0.1:3000
                respond 404
        }
}
```

The two path matches are exact. This block performs no rewrite or redirect, so
the method, query, body, and Authorization header reach TaskDrop unchanged.
Other paths return 404 without reaching the Application.

Do not enable a Caddy access log or debug log for the MCP hostname. A Query
carrier places the Space Key in the request URL. If the shared Caddy instance
has request logging from another configuration, ensure the MCP host and
request-scoped errors are excluded before using Query authentication.

Validate and reload:

```bash
caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
systemctl reload caddy
systemctl status caddy --no-pager
```

Verify public behavior:

```bash
curl --fail --silent --show-error https://<TASKDROP_MCP_HOST>/health
curl --silent --output /dev/null --write-out 'root: HTTP %{http_code}\n' \
  https://<TASKDROP_MCP_HOST>/
```

Health must return `{"status":"ok"}` and the MCP-host root must return 404.
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

Configure clients using the generated Bearer field first. Verify
create -> get latest -> append -> get latest, then send `SIGTERM` and restart
the Application using the procedures in [RUNBOOK.md](./RUNBOOK.md). Read the
same live Handoff again after restart.

## 8. Record acceptance

Record only:

- date and deployed Git commit;
- Node.js, PostgreSQL, Docker, and Caddy versions;
- pass/fail for migration, HTTPS, loopback isolation, both credential carriers,
  Handoff restart persistence, Admin inspection, cleanup, database persistence,
  and retained-log inspection.

Never record a Space Key, Handoff Code, Markdown, database URL, Authorization
value, or complete client configuration. Continue with the Operator acceptance
commands in [RUNBOOK.md](./RUNBOOK.md).
