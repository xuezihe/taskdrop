# P6 Legacy And Modern MCP Contract - Prototype / Throw Away

Question: can one `/mcp` endpoint expose one shared in-memory Handoff Service
to legacy MCP `2025-06-18`, legacy MCP `2025-11-25`, and modern MCP
`2026-07-28` without protocol-specific Handoff logic?

The runner drives the complete matrix automatically. It prints every contract
case, the protocol-era factory calls, cross-era Revision flow, and the final
in-memory state. It deliberately does not test WorkBuddy, persistence,
sessionful legacy transport, or production deployment.

## Run

```sh
pnpm prototype:p6
```

The Prototype binds only to `127.0.0.1`, generates one disposable in-process
Space Key, retains no raw credential or Markdown in its observations, and
destroys all Handoffs when the command exits.

PASS means:

- every version lists and invokes the same three tools;
- tool input/output schemas and application errors are identical;
- `content` and `structuredContent` are equivalent across eras;
- each era can read and append Handoffs created by the other;
- every request uses the same Handoff Service and store;
- the era is observed only by the protocol adapter/factory boundary.

