---
name: taskdrop-handoff
description: Package the current conversation and work state into a TaskDrop Markdown handoff for another AI. Use when the user asks to hand off, transfer, continue, resume, or move the current task to another AI client, or asks to append an updated handoff to an existing TaskDrop code.
---

# TaskDrop Handoff

Create a self-contained Markdown checkpoint, then store it through the TaskDrop MCP server.

## Choose the operation

- No TaskDrop code supplied: call `create_handoff`.
- Existing TaskDrop code supplied: call `get_handoff`, use its numeric `latestRevision` as `baseRevision`, then call `append_revision`.
- User only asks to resume or inspect a handoff: call `get_handoff` with `revision: "latest"` and do not append unless asked.

Never ask for or include the user's TaskDrop Token in tool arguments or Markdown. Authentication belongs to the MCP connection configuration.

## Preserve information in this order

1. The latest user message and latest assistant response.
2. The user's current goal, explicit constraints, and requested next action.
3. Decisions that remain in force.
4. Current artifacts and their paths or URLs.
5. Failed approaches that should not be repeated.
6. Older background needed to understand the task.

Treat the latest exchange as authoritative when it conflicts with earlier discussion. Preserve the latest user message verbatim when practical. Preserve the latest assistant response verbatim or at high fidelity, including unresolved qualifications and warnings. Do not let an older summary erase or soften the final exchange.

If older context is unavailable or appears compressed, say so explicitly instead of reconstructing details.

## Write the handoff

Use this structure and omit empty sections:

```md
# Task Handoff

## Latest Exchange

### User

The latest user message, verbatim when practical.

### Assistant

The latest assistant response, verbatim or high fidelity.

## Current Goal

## Active Constraints

## Decisions in Force

## Current State

## Artifacts

Reference existing specs, plans, ADRs, issues, commits, diffs, and files by path or URL.

## Failed or Rejected Approaches

## Open Questions

## Next Action

## Suggested Skills

Skills the receiving agent should invoke, only when relevant.
```

Do not duplicate large content already captured in another artifact. Reference it. Include the minimum excerpt needed to explain why it matters.

Redact API keys, passwords, access tokens, private credentials, and unnecessary personal information.

## Store and report

Submit the complete Markdown as a full Revision snapshot, never as text appended to the previous Markdown body.

After a successful call, report only:

- TaskDrop code;
- new Revision number;
- expiry time;
- whether this was a new Handoff or an appended Revision.

Tell the user to use the code in the receiving AI. Do not print authentication material.
