# TaskDrop single-server deployment

This is the supported dogfood topology for one Debian VPS:

```text
Internet -> Caddy on the host -> TaskDrop on 127.0.0.1:3000
                                      |
                                      v
                            PostgreSQL in Docker
                              on 127.0.0.1:5432
```

TaskDrop runs as built JavaScript under systemd. PostgreSQL is the only
containerized component. Caddy terminates HTTPS. The Application and database
ports are not published on a public interface.

The commands below assume the deployment checkout is already present at
`/opt/taskdrop/app`. Obtaining and selecting that checkout is outside this
deployment guide.

## 1. Prepare the host

Point the deployment domain's DNS record at the VPS before starting Caddy.
Ports 80 and 443 must reach Caddy; do not open ports 3000 or 5432 in the VPS or
provider firewall.

Install these host dependencies from their official Debian instructions:

- system-wide Node.js 24, with `node` at `/usr/bin/node`
- pnpm 10.13.x
- Docker Engine with the Compose plugin
- Caddy's stable Debian package
- Git and OpenSSL

Official installation references:

- <https://nodejs.org/en/download>
- <https://pnpm.io/installation>
- <https://docs.docker.com/engine/install/debian/>
- <https://caddyserver.com/docs/install#debian-ubuntu-raspbian>

Confirm the installed tools before continuing:

```bash
node --version
pnpm --version
docker --version
docker compose version
caddy version
command -v node
```

`node --version` must report Node.js 24, `pnpm --version` must report 10.13.x,
and `command -v node` must report `/usr/bin/node` because the systemd unit below
uses that fixed path.

Create the service identity and directories:

```bash
sudo adduser --system --group --home /var/lib/taskdrop taskdrop
sudo install -d -o taskdrop -g taskdrop -m 0750 /opt/taskdrop
sudo install -d -o root -g taskdrop -m 0750 /etc/taskdrop
sudo chown -R taskdrop:taskdrop /opt/taskdrop/app
```

## 2. Create protected environment files

The following command generates one random hexadecimal database password inside
the privileged shell, writes both environment files without printing the
password, and does not place the generated value in shell history:

```bash
sudo sh -eu -c '
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
chown root:root /etc/taskdrop/postgres.env
chmod 0600 /etc/taskdrop/postgres.env
chown root:taskdrop /etc/taskdrop/taskdrop.env
chmod 0640 /etc/taskdrop/taskdrop.env
unset password
'
```

The examples beside this guide document the required names. Never copy their
placeholder password into a running deployment. Do not print, paste into a
command argument, or commit either real environment file.

## 3. Start PostgreSQL

From the repository root:

```bash
sudo docker compose -f deploy/server/compose.yml up -d
sudo docker compose -f deploy/server/compose.yml ps
```

Wait until `postgres` is healthy. The Compose file publishes PostgreSQL only on
`127.0.0.1:5432` and keeps its data in the named
`taskdrop_taskdrop-postgres-data` volume. `docker compose down` preserves that
volume; do not use `down --volumes` on a deployment whose data must be retained.

## 4. Build and migrate

Run installation and verification as the service identity:

```bash
cd /opt/taskdrop/app
sudo -u taskdrop pnpm install --frozen-lockfile
sudo -u taskdrop pnpm verify
```

Build output is plain JavaScript under `dist/`. Apply migrations explicitly
before starting or restarting the Application:

```bash
cd /opt/taskdrop/app
sudo -u taskdrop sh -c '
set -a
. /etc/taskdrop/taskdrop.env
set +a
exec /usr/bin/node dist/production/migrate.js
'
```

If migration exits non-zero, stop the deployment here. Do not restart the
Application. Application startup never applies schema changes automatically.

## 5. Install the systemd unit

Create `/etc/systemd/system/taskdrop.service` with this content:

```systemd
[Unit]
Description=TaskDrop Application
Wants=network-online.target
After=network-online.target docker.service

[Service]
Type=simple
User=taskdrop
Group=taskdrop
WorkingDirectory=/opt/taskdrop/app
EnvironmentFile=/etc/taskdrop/taskdrop.env
ExecStart=/usr/bin/node /opt/taskdrop/app/dist/production/main.js
Restart=on-failure
RestartSec=5s
KillSignal=SIGTERM
TimeoutStopSec=30s
UMask=0077
NoNewPrivileges=true
PrivateTmp=true
ProtectHome=true
ProtectSystem=strict

[Install]
WantedBy=multi-user.target
```

Load and start it:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now taskdrop.service
sudo systemctl status taskdrop.service
```

systemd sends `SIGTERM` when stopping the service. TaskDrop then stops accepting
new work, stops cleanup scheduling, lets current work drain, and closes its
PostgreSQL pool before the process exits.

## 6. Configure Caddy

Replace `taskdrop.example.com` with the deployment domain, then put this site
block in `/etc/caddy/Caddyfile`:

```caddyfile
{
    log default {
        exclude http.log.access http.log.error
    }
}

taskdrop.example.com {
    route {
        @taskdrop path /mcp /health
        reverse_proxy @taskdrop 127.0.0.1:3000
        respond 404
    }
}
```

The two path matches are exact. Caddy forwards the original method, URI, query,
body, and request headers to TaskDrop because this configuration performs no
rewrite, redirect, header mutation, caching, or request-body limiting. All other
public paths return 404 without reaching the Application.

Do not add Caddy's `log` directive for this site and do not enable debug logging:
MCP request URIs can carry a Space Key. The global logger exclusion also drops
request-scoped HTTP error events, which can contain the URI when the upstream is
unavailable. Caddy's service journal still retains non-request operational
events such as startup, configuration, and certificate management.

Validate and reload Caddy:

```bash
sudo caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
sudo systemctl reload caddy
sudo systemctl status caddy
```

Once DNS is effective, Caddy obtains and renews the HTTPS certificate
automatically.

## 7. Operate a release

Health checks:

```bash
curl --fail --silent --show-error https://taskdrop.example.com/health
curl --fail --silent --show-error http://127.0.0.1:3000/health
```

The result is `{"status":"ok"}` when PostgreSQL is reachable. A database
failure returns HTTP 503 with `{"status":"unavailable"}` and no internal error
details.

Service lifecycle and retained logs:

```bash
sudo systemctl status taskdrop.service
sudo systemctl restart taskdrop.service
sudo systemctl stop taskdrop.service
sudo systemctl start taskdrop.service
sudo journalctl -u taskdrop.service --since today
sudo journalctl -u caddy.service --since today
sudo docker compose -f /opt/taskdrop/app/deploy/server/compose.yml logs postgres
```

Before restarting for an updated checkout, repeat dependency installation,
`pnpm verify`, the build, and the explicit migration command from section 4.
Migration failure must leave the currently running release untouched.

Run the local-only Admin CLI with the same protected database environment:

```bash
cd /opt/taskdrop/app
sudo -u taskdrop sh -c '
set -a
. /etc/taskdrop/taskdrop.env
set +a
exec /usr/bin/node dist/production/admin-cli.js cleanup-expired
'
```

For inspection, replace the final command with one of:

```text
/usr/bin/node dist/production/admin-cli.js inspect --space-key
/usr/bin/node dist/production/admin-cli.js inspect --space-id <64-character-lowercase-hex>
/usr/bin/node dist/production/admin-cli.js inspect --space-fingerprint <12-character-fingerprint>
```

`--space-key` reads the Space Key from standard input without putting it in the
process arguments. Admin behavior is not routed through Caddy.

## 8. VPS acceptance record

The real VPS smoke remains a user-run acceptance step. Record its date, deployed
Git commit, Node/PostgreSQL/Caddy versions, and pass/fail for each Ticket 21
check. Never record a Space Key, Handoff Code, Markdown, database URL,
Authorization value, or complete client configuration.

At minimum verify from outside the VPS that only HTTPS reaches TaskDrop, then
exercise both credential carriers through exact `/mcp`, restart the Application
and PostgreSQL independently, run Admin inspection and manual cleanup, observe
one scheduled cleanup, and inspect retained Caddy, Application, and PostgreSQL
logs for secret or Handoff content.
