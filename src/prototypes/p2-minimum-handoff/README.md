# P2 Minimum Handoff Loop - Prototype / Throw Away

Question: is `create_handoff -> get_handoff(latest) -> append_revision ->
get_handoff(latest)` a sufficient and coherent interaction contract for
TaskDrop?

Run the Server with one command:

```sh
pnpm prototype:p2
```

It listens on `http://127.0.0.1:4320/mcp`. Override the port with
`TASKDROP_P2_PORT`. State is memory-only and disappears when the process stops.

Configure one Bearer client and one query client with the same disposable Space
Key, using the same provisional P1 credential format. The endpoint accepts:

1. Bearer: `http://127.0.0.1:4320/mcp` plus `bearer_token_env_var`.
2. Query: `http://127.0.0.1:4320/mcp?taskdropKey=<disposable-key>`.

Drive this acceptance sequence with a realistic Markdown Handoff:

1. Bearer `create_handoff`; query `get_handoff` with its Code.
2. Query `create_handoff`; Bearer `get_handoff` with its Code.
3. Append Revision 2 with `baseRevision: 1`, then read `latest`.
4. Read numeric Revision 1 and verify that its Markdown is unchanged.
5. Repeat the append with stale `baseRevision: 1`; verify
   `REVISION_CONFLICT` and that latest remains Revision 2.
6. Use another Space Key through both carriers; verify `HANDOFF_NOT_FOUND`.
7. Send conflicting Header/query credentials; verify authentication is rejected
   before the Handoff Service runs.

The terminal intentionally omits raw Space Keys, raw query strings, and
Markdown bodies. Do not copy credentials into evidence.
