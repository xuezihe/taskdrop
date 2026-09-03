# TaskDrop single-server Operator Runbook

This Runbook operates the public single-server deployment described in
[DEPLOY.md](./DEPLOY.md). Commands assume a root shell, the `main` checkout at
`/opt/taskdrop`, PostgreSQL from `deploy/server/compose.yml`, and the
Application managed by `nohup`. Caddy serves the active Web artifact through
`/var/www/taskdrop/current` and proxies the same-origin Browser API.

Never paste a Space Key, Handoff Code, Markdown, Authorization value, complete
Query URL, or database URL into an incident report or chat.

Set the public hostname once in each operator shell before using the public
checks or release commands:

```bash
taskdrop_public_host=taskdrop.example.com
```

## Status and health

```bash
cd /opt/taskdrop
cat /run/taskdrop-application.pid
ps -fp "$(cat /run/taskdrop-application.pid)"
ss -lntp | grep ':3000'
curl --fail --silent --show-error http://127.0.0.1:3000/health
docker compose -f deploy/server/compose.yml ps
systemctl status caddy --no-pager
```

Run the public health check with the configured hostname:

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
readlink -f /var/www/taskdrop/current
```

`{"status":"ok"}` means the listener and PostgreSQL health probe succeeded.
The root and disposable Handoff path must return the Workspace HTML rather than 404. The unauthenticated `/api/*` probe must return 401, proving that the route
reached the Node credential boundary rather than the SPA fallback. These checks
do not prove authenticated Browser API behavior or WebMCP discovery by
themselves.
HTTP 503 with `{"status":"unavailable"}` usually means PostgreSQL is not
reachable. A 502 from Caddy usually means the Application is not listening.

Treat a PID file as a hint, not proof. If the file exists but `ps` shows no
matching process, remove only `/run/taskdrop-application.pid` and start the
Application. If port 3000 belongs to another process, identify it before
starting another TaskDrop process.

## Start the Application

```bash
cd /opt/taskdrop
test ! -f /run/taskdrop-application.pid || \
  ! kill -0 "$(cat /run/taskdrop-application.pid)" 2>/dev/null
install -d -o root -g root -m 0750 /var/log/taskdrop
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

Verify health and the listener immediately. `nohup` provides neither crash
restart nor boot startup; check the process after a host reboot.

## Stop the Application gracefully

```bash
taskdrop_pid="$(cat /run/taskdrop-application.pid)"
ps -p "$taskdrop_pid" -o pid=,args=
```

Continue only when the displayed command is the TaskDrop
`dist/production/main.js` process from this checkout. This prevents a stale PID
file from targeting an unrelated process after PID reuse. Then stop it:

```bash
kill -TERM "$taskdrop_pid"
for attempt in $(seq 1 30); do
  if ! kill -0 "$taskdrop_pid" 2>/dev/null; then
    break
  fi
  sleep 1
done
if kill -0 "$taskdrop_pid" 2>/dev/null; then
  echo "TaskDrop is still stopping; inspect the log before taking further action."
else
  rm -f /run/taskdrop-application.pid
fi
unset taskdrop_pid attempt
```

`SIGTERM` stops new work and cleanup scheduling, waits for in-flight cleanup,
and closes the PostgreSQL pool. Do not make `kill -9` the normal stop path.

Restart by completing the graceful stop, then following the start procedure.
After restart, read one live Handoff again to verify persistence.

## Inspect retained logs safely

```bash
tail -n 200 /var/log/taskdrop/application.log
journalctl -u caddy.service --since today --no-pager
cd /opt/taskdrop
docker compose -f deploy/server/compose.yml logs --since 24h postgres
```

Application cleanup success contains only operation, deleted Handoff count, and
duration. Cleanup failure is intentionally generic. Search locally for a known
disposable credential only during a controlled leak check; do not print the
matching value into retained output or paste the results elsewhere.

## Inspect a Space

Load the database environment without printing it:

```bash
cd /opt/taskdrop
set -a
. /etc/taskdrop/taskdrop.env
set +a
```

Preferred exact inspection reads a Space Key through hidden terminal input:

```bash
/usr/bin/node dist/production/admin-cli.js inspect --space-key
```

The other exact inputs are:

```bash
/usr/bin/node dist/production/admin-cli.js inspect \
  --space-id <64-character-lowercase-hex>
/usr/bin/node dist/production/admin-cli.js inspect \
  --space-fingerprint <12-character-fingerprint>
```

Finish by removing inherited configuration from the shell:

```bash
unset DATABASE_URL PORT RETENTION_WINDOW_MS LOG_LEVEL
```

Use exactly one identity option. The default result shows the Space
Fingerprint, database time, live/expired/total Handoff counts, Revision count,
retained Markdown byte totals, and one bounded row per stored Handoff. It does
not show Markdown, the raw Space Key, full Space ID, or database URL.

An exact Space Key can describe an empty Space with zero stored Handoffs. A
Fingerprint lookup covers only Space IDs that still have stored Handoffs, so
`No stored Space matches` does not prove that the logical Space never existed.
An ambiguous Fingerprint is refused rather than silently selecting a Space.

## Run one manual cleanup pass

```bash
cd /opt/taskdrop
set -a
. /etc/taskdrop/taskdrop.env
set +a
/usr/bin/node dist/production/admin-cli.js cleanup-expired
cleanup_status=$?
unset DATABASE_URL PORT RETENTION_WINDOW_MS LOG_LEVEL
test "$cleanup_status" -eq 0
unset cleanup_status
```

One pass deletes at most 100 expired Handoffs and cascades to their Revisions.
If the result is exactly 100, run another pass if an immediate drain is needed.
The Application also starts one asynchronous pass after listening and attempts
another pass hourly. A scheduled failure waits for the next pass and does not
deliberately fail `/health`.

## Back up PostgreSQL

The backup contains private Handoff Markdown. Keep it outside the repository
with mode `0600` and apply an appropriate retention policy.

```bash
cd /opt/taskdrop
install -d -o root -g root -m 0700 /root/backups/taskdrop
umask 077
backup_path="/root/backups/taskdrop/taskdrop-$(date -u +%Y%m%dT%H%M%SZ).dump"
docker compose -f deploy/server/compose.yml exec -T postgres \
  pg_dump -U taskdrop -d taskdrop -Fc > "$backup_path"
chmod 0600 "$backup_path"
test -s "$backup_path"
ls -lh "$backup_path"
unset backup_path
```

This is a practical logical backup, not a complete disaster-recovery program.
This deployment does not provide point-in-time recovery, automated restore,
cross-host replication, or a restore drill.

## Upgrade the main checkout

Record the current commit outside any credential-bearing file. Stop if the
working tree is not clean; never overwrite local changes to force an upgrade.

```bash
cd /opt/taskdrop
git status --short
git rev-parse HEAD
git pull --ff-only origin main
pnpm install --frozen-lockfile
TASKDROP_MCP_ORIGIN="https://$taskdrop_public_host" pnpm verify
```

The currently running Node process can stay up during install, verification,
build, and migration. Run the explicit migration with the new build:

```bash
set -a
. /etc/taskdrop/taskdrop.env
set +a
/usr/bin/node dist/production/migrate.js
migration_status=$?
unset DATABASE_URL PORT RETENTION_WINDOW_MS LOG_LEVEL
test "$migration_status" -eq 0
unset migration_status
```

If migration fails, leave the current process and Web symlink unchanged and
investigate. If it succeeds, publish `dist/landing` to a new immutable
`/var/www/taskdrop/releases/<commit>` directory using the procedure in
[DEPLOY.md](./DEPLOY.md), gracefully stop and start the Application, and then
verify:

- loopback and public health;
- `/` and `/handoff/ABC123` SPA delivery;
- same-origin Browser API read and Commit;
- Remote MCP create/read/append behavior;
- one retained Handoff after restart; and
- the five page-scoped tools in the ChatGPT Desktop built-in browser when this
  is a WebMCP release.

The Node checkout commit and `/var/www/taskdrop/current` release must match
before acceptance is recorded.

## Simple code rollback

Rollback is safe only when applied migrations remain compatible with the older
Application. TaskDrop does not automate down migrations.

```bash
cd /opt/taskdrop
git status --short
git switch --detach <KNOWN_GOOD_COMMIT>
pnpm install --frozen-lockfile
TASKDROP_MCP_ORIGIN="https://$taskdrop_public_host" pnpm verify
```

Then run the explicit migration command and publish `dist/landing` from the
same known-good commit to its immutable Web release directory. Switch
`/var/www/taskdrop/current` to that release, gracefully restart, and repeat the
health, SPA, same-origin Browser API, Remote MCP, and WebMCP checks. If the
rollback requires a schema reversal, stop: TaskDrop has no automatic down
migration. Restore an operator-approved PostgreSQL backup only through the
separate database recovery decision.

Return to the current release later with `git switch main` after checking that
the working tree is clean. Keep the failed Web release for diagnosis until it
is safe to remove; do not delete the active or previous release by an
unresolved glob.

## Troubleshooting

### Application does not start

Check the PID, port, and bounded startup log:

```bash
test -f /run/taskdrop-application.pid && \
  ps -fp "$(cat /run/taskdrop-application.pid)"
ss -lntp | grep ':3000' || true
tail -n 100 /var/log/taskdrop/application.log
```

Confirm `/etc/taskdrop/taskdrop.env` exists with mode `0600`, the production
entry points exist, and PostgreSQL is healthy. Do not print `DATABASE_URL`.

### PostgreSQL is unavailable

```bash
cd /opt/taskdrop
docker compose -f deploy/server/compose.yml ps
docker compose -f deploy/server/compose.yml logs --since 30m postgres
ss -lntp | grep ':5432' || true
```

Do not delete or recreate the named volume as a diagnostic shortcut.

### Migration fails

Keep the currently running Application in place. Record only the migration
name and bounded error category; do not share `DATABASE_URL`, SQL parameters,
or private rows. Resolve the database or release mismatch before restarting.

### Cleanup fails

Verify database health, inspect the fixed cleanup failure observation, and run
one manual pass. Cleanup is maintenance: logically expired Handoffs remain
invisible even while physical deletion is delayed.

### Disk space is low

```bash
df -h
docker system df
du -sh /var/log/taskdrop /var/lib/docker 2>/dev/null
```

Rotate or archive known logs and old backups deliberately. Do not run a broad
Docker prune or delete the TaskDrop volume as an emergency first step.

### Caddy returns 502

Check loopback health and the Application PID first, then validate Caddy. A 502
usually means Caddy cannot reach `127.0.0.1:3000`.

### Workspace or `/handoff/:code` returns 404 or 403

Confirm the active Web release and Caddy traversal permissions:

```bash
readlink -f /var/www/taskdrop/current
namei -l /var/www/taskdrop/current/index.html
sudo -u caddy test -r /var/www/taskdrop/current/index.html
caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
```

The Caddy site must serve `/var/www/taskdrop/current`, proxy `/api/*`, and use
`/index.html` as the static fallback. Do not point the Caddy service into
`/opt/taskdrop`. If `/` works but `/handoff/:code` returns 404, inspect
the `try_files` fallback. If the page loads but API calls fail, verify that
`/api/*` is proxied without stripping `/api`.

### Workspace shows the wrong Remote MCP origin

`TASKDROP_MCP_ORIGIN` is embedded during `pnpm build:web` or `pnpm verify`.
Changing the Node environment does not change an existing static artifact.
Rebuild with the correct public origin, publish a new immutable Web release,
and switch the symlink.

### Human Workspace works but WebMCP tools are missing

First confirm `/handoff/:code` is the top-level HTTPS document in the supported
ChatGPT Desktop built-in browser. Inspect proxy/CDN response policies and make
sure they do not disable the WebMCP `tools` capability for the top-level page.
Verify current WebMCP browser requirements against the official sources before
changing security headers. Treat Chrome as an auxiliary check only. A WebMCP
registration failure must not be treated as a reason to disable the Human
Workspace.

### Cloudflare returns 403 to an MCP client

If a browser works but a normal CLI User-Agent fails, disable Browser Integrity
Check and browser challenges for the public hostname. Keep cache-bypass rules
for `/api/*`, `/mcp`, and `/health`. Do not work around the problem by embedding
the credential in a public diagnostic URL.

### A credential entered retained logs

1. Stop using the exposed Space Key and generate a new one locally.
2. Update every MCP client to the new Space Key. The new key addresses a new
   Space; it does not recover or rotate the compromised Space.
3. Restrict access to affected Caddy, Application, PostgreSQL, shell-history,
   backup, and external log copies.
4. Remove or expire retained copies according to the operator's log policy.
5. Assume the old Space remains accessible to anyone holding the old key until
   its Handoffs expire and are physically cleaned.
6. Share only sanitized timestamps and event categories during diagnosis.

There is no public Space purge, key revocation, or account recovery operation in
M3.
