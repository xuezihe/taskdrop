# P1 Codex MCP Smoke — Prototype / Throw Away

Question: can current Codex call one Streamable HTTP MCP tool when the same
Space Key arrives through either a Bearer Header or the `taskdropKey` query,
and what protocol lifecycle does Codex actually use?

Run the Server with one command:

```sh
pnpm prototype:p1
```

It listens on `http://127.0.0.1:4310/mcp`. Override the port with
`TASKDROP_P1_PORT`.

For P1, a Space Key has the provisional format `tdp_` followed by 43 Base64URL
characters. The Server accepts any well-formed Key, derives a 12-character
SHA-256 fingerprint, and discards the raw value before entering the MCP SDK.

Configure Codex twice with the same disposable P1 Key:

1. Header configuration: point at `http://127.0.0.1:4310/mcp` and use
   `bearer_token_env_var`.
2. Query configuration: point at
   `http://127.0.0.1:4310/mcp?taskdropKey=<disposable-p1-key>`.

Call `probe` through each configuration. Its result and the terminal state show
only the derived fingerprint, credential carrier, and observed MCP era. Never
copy the disposable Key into evidence or the P1 ticket.
