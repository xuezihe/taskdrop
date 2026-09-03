# Contributing to TaskDrop

Thanks for helping improve TaskDrop.

## Before starting

- Search existing issues and pull requests for related work.
- Open an issue before a large behavioral or protocol change.
- Keep changes focused and avoid mixing unrelated formatting or refactors.
- Never commit credentials, private Handoffs, environment files, or production
  logs.

## Development setup

TaskDrop requires Node.js 24 and pnpm 10.13.x.

```bash
pnpm install --frozen-lockfile
cp .env.example .env
pnpm verify
```

Database tests require PostgreSQL. Replace the passwords in `.env`, then run:

```bash
docker compose --env-file .env -f db/compose.yml up -d
set -a
. ./.env
set +a
pnpm test:db
```

## Code and tests

- Use TypeScript and ES modules.
- Use two-space indentation, double quotes, semicolons, and Prettier formatting.
- Keep HTTP and MCP adapters separate from application and persistence logic.
- Validate untrusted data at transport and configuration boundaries.
- Add tests at the narrowest stable boundary that protects the behavior.
- Do not expose raw exceptions, SQL details, credentials, or Handoff Markdown in
  public protocol errors or logs.

Run the full verification suite before opening a pull request:

```bash
pnpm verify
```

## Pull requests

Describe the user-visible outcome, security implications, and verification you
performed. Keep commits reviewable and use clear commit subjects. By submitting
a contribution, you agree that it may be distributed under the repository's
Apache-2.0 license.
