---
name: taskdrop
description: Move work between AI clients with TaskDrop by creating, loading, or updating a Handoff. Use when the user asks to transfer or resume work, provides a Handoff Code, or asks what TaskDrop does or how to use it.
---

# TaskDrop

Help the user move work between AI clients without making them learn the
underlying protocol.

## Identify the request

- If the user asks what TaskDrop or this Skill does, explain it without calling
  a Tool. Say that TaskDrop carries current work to another AI through a short
  Handoff Code. Describe `create_handoff`, `get_handoff`, and
  `append_revision` simply as create, load, and update. Give short examples of
  how to ask TaskDrop to hand off current work, load a Code, or update a Code.
  Do not introduce technical details unless the user asks for them.
- If the user asks to create, load, inspect, resume, or update a Handoff, follow
  the operation rules. Do not turn an operational request into a tutorial.
- If the user asks for both an explanation and an operation, explain briefly,
  then continue with the requested operation.

Never ask the user for a Space Key. It belongs in the MCP connection
configuration, never in conversation, Tool arguments, or Handoff Markdown.

## Choose the operation

- When the user requests a new Handoff and supplies no Handoff Code, prepare it
  and call `create_handoff`.
- When the user asks to load, inspect, resume, or update an existing Handoff
  but supplies no Handoff Code, ask for the Code. Never create a different
  Handoff instead.
- When a Handoff Code is supplied without an explicit update request, call
  `get_handoff` with `revision: "latest"`. Load the work and continue; never
  append automatically.
- When the user requests a numeric historical Revision, call `get_handoff` with
  that Revision. Report whether it is latest using the returned
  `latestRevision` and `isLatest`.
- When the user explicitly requests an update, first call `get_handoff` with
  `revision: "latest"`. Build a complete new Markdown snapshot, then call
  `append_revision` with the returned `latestRevision` as `baseRevision`.
- If append returns `REVISION_CONFLICT`, do not claim success. Read latest
  again and tell the user that other work updated the Handoff. Do not overwrite
  or merge it without the user's direction.

## Decide whether to ask

Read the available conversation before asking anything. Respect the user's
stated destination, next step, content preference, and latest instruction.

Before `create_handoff`, ask at most one question only when the missing answer
would materially change the Handoff. Make it about the real tradeoff in the
current work, give two or three concrete choices, and recommend one with a
short reason. Never ask a generic question such as “What should I preserve?”

Treat a request that only says the user wants to switch to another AI as
missing a material content preference. Ask the one context-specific question
before creating the Handoff.

Do not ask when the user already supplied the needed preference, requests an
immediate Handoff, declines confirmation, or the work and destination are
already clear.

## Shape the Handoff

Organize the Markdown for what the receiving AI must do next. Do not force
research, data processing, debugging, implementation, and design into one
template. Read [destination guidance](references/handoff-guidance.md) when
choosing content, resolving a preservation tradeoff, or handling material that
cannot be included.

The user's latest explicit instruction overrides general organization rules
and older context. Preserve valuable source material and structure when the
user asks for completeness; remove meaningless repetition. Keep failed or
rejected paths only when they prevent repeated work. Reference accessible
artifacts instead of duplicating them.

Submit a complete Markdown snapshot for both create and append, never a diff
or a fragment added to the prior Markdown. If required external material is
not accessible to the receiver or the complete content may exceed TaskDrop's
size limit, do not silently omit or truncate it. State what is missing and, if
the choice materially changes the Handoff, use the one-question rule.

## Remove credentials

Before create or append, scan the complete Markdown. Remove every TaskDrop
Space Key, API key, password, access token, and other private credential,
including values copied from messages, terminal output, environment variables,
MCP configuration, and referenced artifacts. Keep only a safe note such as
`API credential is configured; value removed` when useful.

Credential removal overrides requests for verbatim or complete preservation.
Never reconstruct or display a value the Server removed. If a successful result
has `contentSanitized: true`, report its `redactionCount` and say that TaskDrop
removed TaskDrop Space Key material; do not reveal or recover it.

## Report the result

After a successful create or append, report the Handoff Code, new Revision,
expiry, and whether TaskDrop created a Handoff or appended a Revision. Tell the
user to use the Code in the receiving AI.

After a successful get, report the Handoff Code, loaded Revision, expiry, and
whether it is latest. Briefly summarize the actual Markdown: cover the current
goal, progress, important constraints or decisions, unfinished work, and next
step when present. Do not repeat any Space Key, API key, password, access token,
or other private credential found in retrieved Markdown; mention only that
credential material was omitted when relevant. Explicitly say the Handoff is
loaded into the current context and work can continue.

If get fails, say that the Handoff was not loaded. Never invent a summary from
the Code or earlier conversation, and never claim that work can continue from
an unloaded Handoff.
