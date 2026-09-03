# TaskDrop user guide

TaskDrop moves current work between AI clients through temporary, versioned
Markdown Handoffs. You can use a hosted TaskDrop endpoint or deploy the service
yourself.

## The five terms users need

- A **Space** is the private logical area reached with one Space Key.
- A **Space Key** is the bearer credential that grants access to that Space.
  It does not expire with a Handoff and cannot be recovered if lost.
- A **Handoff** is the temporary Markdown working set being moved.
- A **Handoff Code** locates one Handoff inside the already-authorized Space.
  The Code is not a credential by itself.
- A **Revision** is one immutable full Markdown snapshot of a Handoff. Updating
  a Handoff appends another Revision rather than editing an older one.

## Generate and retain a Space Key

Run the Setup CLI locally from a trusted TaskDrop checkout:

```bash
pnpm setup:cli
```

The CLI generates the Space Key locally, does not send it over the network, and
does not save it. Store the exact output in a password manager. Whitespace,
case, and padding changes invalidate it. Do not put it in chat, Handoff
Markdown, issue trackers, screenshots, or shell command arguments.

Losing a Space Key means generating a new one, which creates access to a
different Space. There is no account recovery or key rotation that preserves
access to the old Space.

## Configure an MCP client

For current client-specific instructions for Codex, Claude Code, WorkBuddy,
Cursor, Devin, and generic Streamable HTTP clients, see
[Connect TaskDrop to an MCP client](./mcp-client-setup.md).

Replace `<YOUR_TASKDROP_ORIGIN>` with the HTTPS origin supplied by the
operator. Use the exact `/mcp` path without a trailing slash or redirect.

Bearer is recommended:

```json
{
  "taskdrop": {
    "url": "<YOUR_TASKDROP_ORIGIN>/mcp",
    "transport": "http",
    "headers": {
      "Authorization": "Bearer <YOUR_SPACE_KEY>"
    }
  }
}
```

Use the Query carrier only when the client cannot send an Authorization
header:

```json
{
  "taskdrop": {
    "url": "<YOUR_TASKDROP_ORIGIN>/mcp?taskdropKey=<YOUR_SPACE_KEY>",
    "transport": "http"
  }
}
```

A Query credential passes through browser history, proxy handling, URL
inspection, and other URL-handling infrastructure. Treat the complete URL as a
secret. Do not paste it into diagnostics or retained logs.

Check the operator's health URL without a credential:

```bash
curl --fail --silent --show-error <YOUR_TASKDROP_ORIGIN>/health
```

Expected body:

```json
{ "status": "ok" }
```

## Install the TaskDrop Skill

The distributable Skill is the complete `skills/taskdrop/` directory, including
its `references/` and `agents/` children. Do not copy only `SKILL.md`.

For Codex, place the directory at:

```text
~/.agents/skills/taskdrop/
```

Then invoke it explicitly with `$taskdrop`, or let Codex select it from a
matching request. Restart Codex if an installed update does not appear.

For Devin, commit or copy the same directory to the repository-scoped path:

```text
.agents/skills/taskdrop/
```

Invoke it with `@skills:taskdrop`. The MCP connection must also be configured;
the Skill explains how to use TaskDrop but does not create the connection.

## Create, load, and update Handoffs

Create a new Handoff:

```text
$taskdrop Move the current implementation work to Devin. Preserve the decisions,
rejected approaches, current diff, and exact next step.
```

When the request already states what the receiving AI needs, the Skill creates
the Handoff directly. If a missing preference would materially change the
Handoff, it asks at most one context-specific question.

After a successful create, expect:

- the Handoff Code;
- Revision 1 and expiry;
- whether TaskDrop removed TaskDrop Space Key material;
- an approximate character or word count of the Markdown actually returned as
  stored.

The size signal helps distinguish a detailed working set from a very short
summary. Length does not prove that the Handoff is complete, correct, or high
quality.

Load a Handoff in the receiving AI:

```text
$taskdrop Load Handoff Code ABC123 and continue the work.
```

The Skill reads latest by default. It reports the loaded Revision and expiry,
summarizes the actual Markdown, and confirms that the context is loaded. Merely
loading a Code does not create a new Revision.

Update the same Handoff after more work:

```text
$taskdrop Update Handoff Code ABC123 with the current complete state.
```

The Skill reads latest first and appends a complete new snapshot. It does not
submit a diff. If another client updated the same base Revision, the Skill
reports the conflict and does not overwrite or merge it silently.

## Retention and limits

The operator configures one service-wide **Retention Window**. A new Handoff is
available until its expiry. A successful append starts a fresh Retention Window
for the Handoff; a read does not extend it.

After expiry, the Handoff is immediately unavailable through the Tools and
cannot be recovered. Physical PostgreSQL cleanup happens asynchronously after
logical expiry, so deletion from storage may occur later.

Each Revision is a complete snapshot and is limited to 256 KiB of UTF-8
Markdown. One Handoff supports at most 25 Revisions. If required source material
is too large or unavailable to the receiving AI, decide what to preserve rather
than silently truncating it.

## Privacy boundary

The Server sees Markdown in memory while processing and storing it. TaskDrop
replaces canonical TaskDrop Space Keys found in create and append Markdown and
reports how many replacements occurred. This protection is not a general secret
scanner. It does not guarantee removal of passwords, API keys, access tokens,
private URLs, personal data, or credentials in other formats.

Review sensitive content before creating or updating a Handoff. The Skill also
removes credentials it recognizes, but the user remains responsible for what is
shared.

## Client compatibility notes

TaskDrop has been exercised with Codex and Devin through remote MCP. Client
configuration and transport behavior can change between releases, so use the
current client documentation and report the exact client version when filing a
compatibility issue. Configuration examples for other clients are guidance,
not a guarantee that every client release has been verified.
