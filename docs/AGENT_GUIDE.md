# Agent Guide — MCP Tools Controller

This document is written for AI models. If you are an AI agent connected to a server named `mcp-tools-controller` (or about to connect to one), this is your operating manual.

> You don't have to be handed this file: a short version is delivered automatically in the MCP `initialize` response (`instructions`), and the full text is available as the resource `mcp-controller://agent-guide` (`resources/read`). A live JSON snapshot of plugin status is at `mcp-controller://plugins`.

## Mental model

You are connected to a **gateway**, not a single tool server. Behind it sits a registry of **plugins** — independent MCP servers. The gateway validates plugins when they are added, proxies your tool calls to them, and lets you **rewire the plugin set at runtime**. Tools named `<plugin>__<tool>` (double underscore) belong to a plugin; tools named `plugin_*` are the gateway's own management tools.

## Two control planes

| Situation | Use |
| --- | --- |
| You are already connected to the gateway | The `plugin_*` MCP tools (preferred — changes take effect immediately and you see the result) |
| You only have shell access, or the gateway is not running | The `mcpctl` CLI (`npx -y mcp-tools-controller <command>`) |

Both write the same registry file, so they never conflict: a CLI change is pushed to you via `tools/list_changed`, and your `plugin_*` calls are visible to `mcpctl list` instantly.

## Connecting this gateway to a client

```sh
# Claude Code, stdio (Claude Code spawns the gateway):
claude mcp add mcp-controller -- npx -y mcp-tools-controller serve

# Claude Code, Streamable HTTP (shared long-running gateway):
npx -y mcp-tools-controller serve --http --port 3000   # keep running
claude mcp add --transport http mcp-controller http://127.0.0.1:3000/mcp

# Claude Desktop (no CLI exists — this edits claude_desktop_config.json,
# merging with existing entries; user must fully restart Claude Desktop):
npx -y mcp-tools-controller install claude-desktop

# Claude Desktop sharing the long-running HTTP gateway (Desktop spawns the
# built-in stdio<->HTTP bridge, so hot reloads reach it like any other client):
npx -y mcp-tools-controller serve --http --port 3000   # keep running
npx -y mcp-tools-controller install claude-desktop --http --port 3000
```

## Management tools

### plugin_list — always start here

Input: `{}`
Returns every plugin with `state` (`ready` / `connecting` / `error` / `disabled`), `toolCount`, `tools`, last `validation`, and last `error`.

### plugin_add — hot-connect a new MCP server

Input (stdio): `{ "name": "github", "command": "npx", "args": ["-y", "@modelcontextprotocol/server-github"], "env": {"GITHUB_TOKEN": "..."} }`
Input (remote): `{ "name": "linear", "url": "https://mcp.linear.app/mcp", "headers": {"Authorization": "Bearer ..."} }`

Rules:
- `name` must match `^[a-z][a-z0-9-]{0,31}$` — lowercase, digits, hyphens. No underscores.
- The server is validated before registration (MCP handshake + tools/list, 15s timeout). On failure you get `isError` with the reason; nothing is registered.
- On success the response includes the validation report, and a `tools/list_changed` notification follows.

Example success response:

```json
{
  "added": "github",
  "validation": {
    "ok": true,
    "serverName": "github-mcp-server",
    "toolCount": 26,
    "toolNames": ["create_issue", "..."]
  },
  "note": "Tool list changed — call tools/list again to see the new 'github__*' tools."
}
```

### plugin_remove — disconnect and deregister

Input: `{ "name": "github" }`. Its `github__*` tools disappear immediately.

### plugin_enable / plugin_disable

Input: `{ "name": "..." }`. Disable keeps the configuration so the plugin can be re-enabled later without re-specifying the command.

### plugin_reload

Input: `{ "name": "github" }` to reconnect one plugin (use after it crashed or its underlying server was updated), or `{}` to re-read the registry and reconnect everything.

### plugin_validate

Input: `{ "name": "github" }`. Re-runs the legitimacy check and returns the report. Use it when a plugin behaves oddly and you want fresh evidence before deciding to reload or remove it.

## The verification ritual (hot update)

After any mutation (`plugin_add`, `plugin_remove`, enable/disable/reload):

1. Expect a `notifications/tools/list_changed` notification from the gateway.
2. Call `tools/list` again. Do not assume the old tool list is still valid.
3. New tools appear as `<plugin>__<tool>`; removed plugins' tools are gone.

If your client runtime refreshes tools automatically on `list_changed`, step 2 happens for you.

## Error semantics

| Symptom | Meaning | Your move |
| --- | --- | --- |
| Tool result with `isError: true`, text says plugin is `not available` / `state: error` | The plugin crashed or its process died; the gateway is fine | Call `plugin_reload` with that plugin's name, then retry the tool |
| `plugin_add` returns `isError` with a validation message | The target is not a working MCP server (bad command, no tools capability, handshake timeout) | Fix the command/url; do not retry the identical input |
| Tool result `isError` saying `Unknown tool` | The tool list changed since you last looked | Call `tools/list` (or `plugin_list`) and use a current name |
| A plugin's tools vanished from `tools/list` | It was removed/disabled, or it crashed and is in backoff reconnect | `plugin_list` to see its state; `plugin_reload` if `error` |

A failing plugin never takes down the gateway. Other plugins' tools keep working.

## Audit trail

Every action you take through `plugin_*` tools is recorded in the gateway's audit log with `actor: "mcp-tool"`. Operators can review it with `mcpctl logs`. Act accordingly: prefer `plugin_disable` over `plugin_remove` when you only need to silence a plugin temporarily.
