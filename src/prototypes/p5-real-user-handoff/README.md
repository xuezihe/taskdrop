# P5 Real User Handoff - Prototype / Throw Away

Question: can the minimal Setup Page, TaskDrop Handoff Skill, Devin Desktop,
and Codex move one realistic task through a localhost MCP Server without
copying Markdown or re-explaining constraints?

P5 does not re-test public ingress or hosted ChatGPT. P3 retains that evidence.

## Run

```sh
pnpm prototype:p5
```

Open `http://127.0.0.1:4340/`. Generate one disposable Space Key and install the
generated MCP configurations manually in Devin Desktop and Codex. Keep the P5
terminal running throughout acceptance; all Handoffs are memory-only.

The Setup Page uses browser Web Crypto for 32 random bytes and has a Content
Security Policy with `connect-src 'none'`. It does not use fetch, cookies,
analytics, URL parameters, `localStorage`, or `sessionStorage`.

## Client configuration basis

- Devin Desktop: HTTP transport, `serverUrl`, and an Authorization Bearer
  header. The generated JSON is a custom-server object for manual installation.
- Codex: Streamable HTTP plus `bearer_token_env_var`. The generated shell
  command reads the disposable Key without terminal echo, exports it, and adds
  `taskdrop-p5` through the CLI. Copy the Key separately when the hidden prompt
  waits for input; do not paste a literal Key into a shell command. After the
  command finishes, start or restart Codex from that same shell so it inherits
  the environment variable.
- MCP connection setup and Handoff Skill setup are deliberately separate.

Configuration references: [Devin MCP](https://docs.devin.ai/work-with-devin/mcp),
[Devin Desktop MCP](https://docs.devin.ai/work-with-devin/devin-mcp), and
[Codex MCP](https://learn.chatgpt.com/docs/extend/mcp).

Run both clients with this repository as their working context. If either
client does not auto-discover project skills, explicitly ask it to read and
follow `skills/taskdrop/SKILL.md` before creating or appending the real
Handoff.

If an existing `taskdrop-p5` Codex entry exists, remove or update it before
adding the new disposable Key. Start or restart Codex from the shell that
exports `TASKDROP_P5_SPACE_KEY`.

## Manual acceptance

### A. Devin readiness

1. Type `d` and Return in the P5 terminal.
2. In Devin Desktop, verify all three tools are visible.
3. Complete `create -> get latest -> append -> get latest` using a throwaway
   Markdown body.
4. Confirm every terminal observation uses one scope fingerprint and succeeds.

Stop and report the sanitized observations if readiness fails. Do not hide a
Devin compatibility problem inside the real-user flow.

### B. Realistic Handoff

1. Type `s` and Return.
2. In Devin Desktop, use the TaskDrop Handoff Skill to package a realistic
   current task and call `create_handoff`.
3. Transfer only the six-character Handoff Code to Codex. Do not manually copy
   the Markdown.
4. Type `c` and Return.
5. In Codex, read `latest`, continue the task, then append a complete new
   Revision through the Handoff Skill.
6. Type `r` and Return.
7. In Devin Desktop, read the new `latest` and confirm that work can continue
   without the user restating the goal or constraints.
8. Read numeric Revision 1 and confirm it is unchanged.

Record whether the Handoff preserved the latest exchange, goal, constraints,
decisions, artifacts, failed attempts, open questions, and next action. Existing
large artifacts should be referenced rather than duplicated.

## Stop

Type `q` and Return. The Server closes and all Handoffs disappear. Treat the
Space Key as disposable and remove the temporary client configurations.

Terminal logs omit raw credentials, raw query strings, tool arguments, and
Markdown. Retain only sanitized stage, protocol, carrier, scope fingerprint,
tool/result, Revision, and Markdown-length observations.

The Handoff Service automatically replaces every TaskDrop Space Key in
`create_handoff` and `append_revision` Markdown with
`[REDACTED TASKDROP SPACE KEY]` before storing the immutable Revision. Success
results expose `contentSanitized` and `redactionCount`; raw Keys are never
returned or retained in Handoff state.
