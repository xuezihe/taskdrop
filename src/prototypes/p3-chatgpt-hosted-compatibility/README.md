# P3 ChatGPT Hosted Compatibility - Prototype / Throw Away

Question: does ChatGPT Business preserve a `taskdropKey` URL credential through
its MCP lifecycle, and can an Owner using Web Standard Chat invoke TaskDrop's
read and write tools?

## Fixed compatibility row

- Plan: ChatGPT Business
- Workspace role: Owner
- Surface: Web
- Mode: Standard Chat
- Developer Mode: enabled
- App state: draft custom app

Do not extrapolate the result to another plan, role, surface, mode, or action
policy.

## Prerequisite

Install the current official `cloudflared` binary. P3 uses an ephemeral
Cloudflare Quick Tunnel; it does not add `cloudflared` as a project dependency.

## Run

```sh
pnpm prototype:p3
```

The launcher starts the memory-only Server on `127.0.0.1:4330`, opens a random
Quick Tunnel, performs a public MCP preflight, generates a disposable Space
Key, and copies the complete credential URL to the macOS clipboard. It prints
only the public origin and sanitized credential fingerprint.

When preflight says `passed`:

1. In ChatGPT Business Web, enable Developer Mode.
2. Create a draft custom app for the endpoint copied to the clipboard.
3. Select `No Authentication` because the disposable credential is in the URL.
4. Return to the terminal and press `[1]`; this marks Tool Scan and clears the
   clipboard. Then click Scan Tools.
5. Verify `create_handoff`, `get_handoff`, and `append_revision` are visible.
6. Press `[2]`, then complete `create -> get latest -> append -> get latest` in
   Standard Chat. Accept and record any write confirmation.
7. Press `[3]`, then call `get_handoff` again later in the same conversation.
8. Press `[4]`, reopen the conversation, and call `get_handoff`.
9. Press `[5]`, refresh ChatGPT Web, reconnect/select the app if needed, and
   call `get_handoff` again.
10. Record the actual action policy, confirmation behavior, visible tools, and
    call results. Do not copy the endpoint or Space Key into evidence.
11. Delete the draft app, then press `[q]`. The launcher stops the Quick Tunnel,
    destroys in-memory Handoffs, and clears the clipboard if still necessary.

The terminal records only lifecycle stage, RPC method, tool name, sanitized
carrier/fingerprint, protocol version, session presence, and response status.
It omits raw URLs, query strings, credentials, tool arguments, and Markdown.

If any stage loses the query credential, stop and retain sanitized evidence.
P3 must open a separate OAuth-to-Space design ticket rather than adding OAuth
inside this Prototype.
