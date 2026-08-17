# Connect TaskDrop to an MCP client

TaskDrop is a remote MCP server using the Streamable HTTP transport. Configure
the same Space Key in every client that should access one Space. The Handoff
Code locates a Handoff inside that Space; it does not replace the Space Key.

This guide separates client documentation from observed TaskDrop compatibility.
A configuration shown here is not a claim that every release of that client has
been tested against TaskDrop.

## Connection details

- Endpoint: `https://taskdrop.xuezihe.com/mcp`
- Transport: Streamable HTTP
- Recommended authentication: `Authorization: Bearer <YOUR_SPACE_KEY>`
- Fallback authentication: append `?taskdropKey=<YOUR_SPACE_KEY>` to the
  endpoint only when the client cannot send an Authorization header

The Space Key is a bearer credential. Keep it out of chat, Handoff Markdown,
screenshots, committed configuration, shell history, issue trackers, and logs.
The complete Query URL is also a credential.

## Client status

| Client | Configuration source | TaskDrop status |
| --- | --- | --- |
| Codex | Official client documentation | Observed in private dogfood; exact build not recorded |
| Claude Code | Official client documentation | Configuration documented; TaskDrop not yet verified |
| WorkBuddy | Official client documentation | Configuration UI documented; TaskDrop not yet verified |
| Cursor | Official client documentation | Configuration documented; TaskDrop not yet verified |
| Devin | Client-specific configuration | Observed in private dogfood; exact build not recorded |
| Other MCP clients | Client-specific | Not verified |

The observations above were current on 2026-08-17. If a client release behaves
differently, use its current MCP documentation and report the exact client
version with the result.

## Codex

Codex reads MCP configuration from `~/.codex/config.toml`. For a project-scoped
configuration, use `.codex/config.toml` only in a trusted project.

Recommended Bearer configuration:

```toml
[mcp_servers.taskdrop]
url = "https://taskdrop.xuezihe.com/mcp"
bearer_token_env_var = "TASKDROP_SPACE_KEY"
```

Make `TASKDROP_SPACE_KEY` available in the environment that launches Codex.
Store the value in a password manager or secret manager rather than writing it
into `config.toml` or a shell command.

Query fallback:

```toml
[mcp_servers.taskdrop]
url = "https://taskdrop.xuezihe.com/mcp?taskdropKey=<YOUR_SPACE_KEY>"
```

This writes the credential into the configuration file. Prefer the Bearer form.
Restart the Codex host after changing its MCP configuration, then inspect `/mcp`.

Source: [OpenAI MCP documentation](https://developers.openai.com/codex/mcp/).

## Claude Code

Claude Code supports remote HTTP servers in `.mcp.json`. Use environment
variable expansion so the Space Key does not appear in a committed file:

```json
{
  "mcpServers": {
    "taskdrop": {
      "type": "http",
      "url": "https://taskdrop.xuezihe.com/mcp",
      "headers": {
        "Authorization": "Bearer ${TASKDROP_SPACE_KEY}"
      }
    }
  }
}
```

Make `TASKDROP_SPACE_KEY` available in the environment that launches Claude
Code. Reconnect the server with `/mcp` after changing the configuration.

Query fallback:

```json
{
  "mcpServers": {
    "taskdrop": {
      "type": "http",
      "url": "https://taskdrop.xuezihe.com/mcp?taskdropKey=<YOUR_SPACE_KEY>"
    }
  }
}
```

Do not commit the Query form. Prefer the Bearer form.

Source: [Claude Code MCP documentation](https://docs.anthropic.com/en/docs/claude-code/mcp).

## WorkBuddy

WorkBuddy provides a visual MCP configuration flow:

1. Open **Settings → MCP**.
2. Select **Add MCP Server**.
3. Enter `https://taskdrop.xuezihe.com/mcp` as the server URL.
4. If the UI supports a Bearer token or Authorization header, use the Space Key
   as `Authorization: Bearer <YOUR_SPACE_KEY>`.
5. If the UI only accepts a URL, use the Query fallback URL shown on the
   TaskDrop Landing Page.
6. Save, reconnect, and confirm that the TaskDrop tools appear.

WorkBuddy also documents user-level `~/.workbuddy/mcp.json` and project-level
`.workbuddy/mcp.json` configuration. Its public guide does not currently provide
a complete remote HTTP JSON example with custom headers, so this guide does not
invent one. Do not commit a project-level file containing a Space Key.

Source: [WorkBuddy MCP documentation](https://www.codebuddy.cn/docs/workbuddy/From-Beginner-to-Expert-Guide/Function-Description/MCP-Guide).

## Cursor

Cursor reads global MCP configuration from `~/.cursor/mcp.json` and
project-scoped configuration from `.cursor/mcp.json`.

Bearer configuration:

```json
{
  "mcpServers": {
    "taskdrop": {
      "url": "https://taskdrop.xuezihe.com/mcp",
      "headers": {
        "Authorization": "Bearer <YOUR_SPACE_KEY>"
      }
    }
  }
}
```

This stores the Space Key as plain text. Use only a global file with suitably
restricted permissions, and never commit it. If the installed Cursor version
does not send custom headers reliably, use the Query fallback:

```json
{
  "mcpServers": {
    "taskdrop": {
      "url": "https://taskdrop.xuezihe.com/mcp?taskdropKey=<YOUR_SPACE_KEY>"
    }
  }
}
```

Restart or reconnect the MCP server after editing the file.

Source: [Cursor MCP documentation](https://docs.cursor.com/context/model-context-protocol).

## Devin and other MCP clients

Use the client's remote MCP or Streamable HTTP setup screen with these values:

```text
Name: TaskDrop
URL: https://taskdrop.xuezihe.com/mcp
Transport: Streamable HTTP
Header: Authorization: Bearer <YOUR_SPACE_KEY>
```

If custom headers are unavailable, use:

```text
https://taskdrop.xuezihe.com/mcp?taskdropKey=<YOUR_SPACE_KEY>
```

Configuration keys such as `type`, `transport`, `headers`, and `http_headers`
belong to individual client schemas. Do not translate them mechanically from
one client to another.

## Verify the connection

First check the public health endpoint without a credential:

```bash
curl --fail --silent --show-error https://taskdrop.xuezihe.com/health
```

Expected response:

```json
{"status":"ok"}
```

Then reconnect the MCP server in the client and confirm that its TaskDrop tools
appear. Do not paste a Space Key or Query URL into diagnostics retained by the
client.

After the connection works, follow the
[TaskDrop user guide](./taskdrop-user-guide.md#install-the-taskdrop-skill) to
install the complete Skill and create the first Handoff.
