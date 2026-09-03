# Security Policy

## Supported version

Security fixes are applied to the latest code on the `main` branch. The project
does not currently maintain multiple supported release lines.

## Report a vulnerability privately

Do not open a public issue for a suspected vulnerability, exposed credential,
private Handoff, or other sensitive report. Use GitHub's private vulnerability
reporting flow:

<https://github.com/xuezihe/taskdrop/security/advisories/new>

Include only the minimum information needed to reproduce the problem. Do not
include a real Space Key, complete credential-bearing URL, production database
URL, or private Handoff Markdown. Use disposable test data and redact logs.

If a credential may have been exposed, rotate or revoke it immediately. Removing
it from a report or Git history does not make the credential safe to reuse.

## Security boundaries

- Space Keys are bearer credentials and must be stored outside the repository.
- Handoff Codes are locators, not authentication factors.
- TaskDrop redacts its canonical Space Key format before persisting Markdown,
  but it is not a general secret scanner.
- The server processes and stores Handoff Markdown until expiry and asynchronous
  cleanup; operators are responsible for database, backup, and log security.
- Browser Workspace and Browser API deployments must share the same origin.

Reports are reviewed on a best-effort basis. Public disclosure should wait until
a fix and release plan have been coordinated.
