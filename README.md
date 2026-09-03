# TaskDrop

TaskDrop is a temporary, versioned handoff layer for moving active work between
AI clients. An AI saves a complete Markdown checkpoint, TaskDrop returns a short
Handoff Code, and another client can load the latest Revision and continue.

TaskDrop is open source under the Apache License 2.0. It includes a remote MCP
server, a browser Workspace with page-scoped WebMCP tools, and a distributable
TaskDrop Skill.

## What it provides

- Account-free Spaces protected by locally generated bearer credentials.
- Immutable, append-only Markdown Revisions.
- Short Handoff Codes that locate work without acting as credentials.
- Optimistic conflict detection for concurrent updates.
- Automatic expiry under an operator-configured Retention Window.
- Remote MCP tools and a browser Workspace served from one deployment.
- Defense-in-depth redaction of canonical TaskDrop Space Keys before storage.

TaskDrop is not a general-purpose secret scanner. Review a Handoff before
sharing it, and never include passwords, API keys, private URLs, or personal
data that the receiving client does not need.

## Requirements

- Node.js 24
- pnpm 10.13.x
- PostgreSQL 18

## Local setup

Install dependencies and prepare local configuration:

```bash
pnpm install --frozen-lockfile
cp .env.example .env
```

Replace the example password in both `POSTGRES_PASSWORD` and `DATABASE_URL`,
then start PostgreSQL:

```bash
docker compose --env-file .env -f db/compose.yml up -d
```

Load the application settings, run migrations, build, and start TaskDrop:

```bash
set -a
. ./.env
set +a
pnpm migrate
pnpm build:web
pnpm start
```

The runtime listens on `127.0.0.1:3000` by default. In another terminal, start
the Vite development server when working on the browser UI:

```bash
pnpm dev:web
```

The production deployment guide explains how to serve the Web build and Node
runtime from one HTTPS origin.

## Generate a Space Key

```bash
pnpm setup:cli
```

Store the generated key in a password manager. It cannot be recovered, and a
new key opens a different Space rather than rotating the old credential.

Configure the same key in each MCP client that should share the Space. Bearer
authentication is recommended:

```text
Authorization: Bearer <YOUR_SPACE_KEY>
```

Use a query credential only for clients that cannot send custom headers. The
complete query URL is itself a credential and must not be logged or committed.

## Documentation

- [User guide](docs/taskdrop-user-guide.md)
- [MCP client setup](docs/mcp-client-setup.md)
- [Deployment overview](docs/deployment.md)
- [Single-server deployment](deploy/server/DEPLOY.md)
- [Operator runbook](deploy/server/RUNBOOK.md)
- [Database development setup](db/README.md)
- [Contributing](CONTRIBUTING.md)
- [Security policy](SECURITY.md)

## Development

Run the complete verification suite before submitting a change:

```bash
pnpm verify
```

This checks formatting and TypeScript, builds the Node and Web applications,
and runs the test suite. Database integration tests are available separately:

```bash
pnpm test:db
```

## Security model

A Space Key is a bearer credential. A Handoff Code is only a locator inside an
already authenticated Space. Reads do not extend retention; a successful
Revision append does. Expired Handoffs become unavailable immediately and are
removed from PostgreSQL asynchronously.

See [SECURITY.md](SECURITY.md) before reporting a vulnerability.

## License

Licensed under the [Apache License 2.0](LICENSE).
