# MCP Tools Controller

Manage MCP servers as **plugins** and aggregate them behind **one hot-reloading MCP gateway**.

Every downstream MCP server is treated as a plugin: it is **validated on connect** (full MCP handshake + tool discovery), **recorded** in a registry and an audit log, and its tools are re-exposed through a single MCP endpoint as `<plugin>__<tool>`. Plugins can be added and removed **while the gateway is running** — from the shell (`mcpctl`) or by the connected model itself (built-in `plugin_*` tools) — and every connected client is notified instantly via `notifications/tools/list_changed`.

[简体中文文档](./README.zh-CN.md) · [Agent integration guide (for AI models)](./docs/AGENT_GUIDE.md)

## Import into Claude Code (one command)

```sh
claude mcp add mcp-controller -- npx -y mcp-tools-controller serve
```

That's it. Claude Code now sees every plugin's tools through one server, plus the built-in management tools. Or let the CLI build the exact command for your setup:

```sh
npx -y mcp-tools-controller install claude --print
```

## Architecture

```
            (manage)                        (aggregate)
 ┌─────────┐  mcpctl   ┌─────────────────┐   MCP    ┌──────────────────┐
 │  shell  ├──────────►│  plugins.json   │◄────────►│     gateway      │
 └─────────┘           │  (registry,     │  watch / │  stdio and/or    │
 ┌─────────┐ plugin_*  │   single source │  write   │  Streamable HTTP │
 │  model  ├──────────►│   of truth)     │          └───────┬──────────┘
 └─────────┘  tools    └─────────────────┘                  │ proxy
                              audit.log            ┌────────┼────────┐
                              (JSONL)              ▼        ▼        ▼
                                                plugin A  plugin B  plugin C
                                                (stdio)   (stdio)   (http)
```

- The **registry file** (`~/.mcp-controller/plugins.json` by default) is the single source of truth. The CLI writes it; the gateway watches it (debounced, atomic-rename safe) and reconciles live connections against it.
- Both control planes — shell and model — converge on the same file, so changes made by one are immediately visible to the other.
- The **audit log** (`audit.log`, JSONL, next to the registry) records every plugin lifecycle event and every proxied tool call, with an `actor` field (`cli` / `gateway` / `mcp-tool`) so you can tell who did what.

## Quick start

```sh
# Requires Node.js >= 18. Task (taskfile.dev) is the canonical entrypoint;
# every task wraps an npm script, so `npm run <name>` works without Task.
task install   # or: npm install
task build     # or: npm run build

# 1. Register your first plugin — the other party provides the launch command after '--'
node dist/cli.js add demo -- node dist/examples/demo-server.js
#   Validating 'demo' (MCP handshake + tools/list)...
#   Validated: demo-server@1.0.0 — 3 tool(s): echo, add, now

# 2. Inspect
node dist/cli.js list
node dist/cli.js logs

# 3. Serve the aggregation gateway
node dist/cli.js serve                       # stdio (for MCP clients that spawn you)
node dist/cli.js serve --http --port 3000    # Streamable HTTP at /mcp (shared, multi-client)

# 4. Hot reload: with the gateway still running, in another shell:
node dist/cli.js add other -- npx -y some-mcp-server
# connected clients receive tools/list_changed within ~300ms — no restart
```

Installed from npm, replace `node dist/cli.js` with `mcpctl` (global install) or `npx -y mcp-tools-controller`.

## CLI reference

| Command | Description |
| --- | --- |
| `mcpctl add <name> [opts] -- <command> [args...]` | Register a stdio plugin. Validated before saving (skip with `--skip-validate`). Options: `--env K=V` (repeatable), `--cwd <dir>`, `--force`. |
| `mcpctl add <name> --url <endpoint> [--header K=V]` | Register a remote Streamable HTTP plugin. |
| `mcpctl remove <name>` | Remove a plugin; a running gateway disconnects it immediately. |
| `mcpctl list [--json]` | List plugins: transport, enabled, validation health, tool count, target. |
| `mcpctl validate <name> \| --all` | Re-run the legitimacy check and persist the result. |
| `mcpctl enable <name>` / `disable <name>` | Toggle a plugin without losing its config. |
| `mcpctl call <plugin> <tool> [--args '{...}']` | One-shot debug call straight to a plugin (no gateway needed). |
| `mcpctl serve [--http] [--port N] [--host H] [--no-management]` | Start the gateway. |
| `mcpctl import <.mcp.json>` | Bulk-import from a Claude Code config (same `{command, args, env}` shape). |
| `mcpctl install claude [--http] [--port N] [--print]` | Print/run the Claude Code import command. |
| `mcpctl logs [-n 50]` | Show recent audit log entries. |

Every command accepts a global `--registry <path>`; otherwise the registry resolves to `$MCP_CONTROLLER_HOME/plugins.json`, then a project-local `./.mcp-controller/plugins.json` (if present), then `~/.mcp-controller/plugins.json`.

## Validation ("is this plugin legitimate?")

`add` and `validate` run a real connection check before anything is registered:

1. Static checks — plugin name must match `^[a-z][a-z0-9-]{0,31}$` (no underscores: they are reserved for the `plugin__tool` namespace separator), and the transport config must be complete.
2. Full MCP `initialize` handshake (15s timeout; hung child processes are killed).
3. The server must advertise the `tools` capability.
4. `tools/list` is fetched (with pagination) and every tool name is checked against the MCP spec charset and the 128-char namespaced-name budget.

The resulting record — server name/version, negotiated protocol version, tool inventory, timestamp — is stored on the plugin entry and appended to the audit log.

## Hot reload

Two paths, same mechanism:

- **Shell**: any `mcpctl add/remove/enable/disable` writes the registry atomically. The running gateway watches the registry directory, diffs desired state against live connections, then connects/disconnects only what changed.
- **Model**: the gateway exposes built-in management tools (`plugin_add`, `plugin_remove`, `plugin_enable`, `plugin_disable`, `plugin_reload`, `plugin_validate`, `plugin_list`). These write through to the same registry file.

Either way the gateway emits `notifications/tools/list_changed` to **every** connected client (all HTTP sessions, or the stdio client), which then re-fetches `tools/list`. Downstream hot updates propagate too: if a plugin changes its own tool list at runtime, the gateway re-fetches and notifies upward.

A crashed plugin never takes the gateway down: it is marked unhealthy, its tools are withdrawn from the aggregate list, and reconnection is retried with backoff (1s → 2s → 5s → 15s → 30s). Calling a tool of an unhealthy plugin returns an `isError` result with a recovery hint instead of a protocol error.

## Using it from Claude Code

stdio (simplest — Claude Code spawns the gateway):

```sh
claude mcp add mcp-controller -- npx -y mcp-tools-controller serve
```

Streamable HTTP (one shared gateway, many clients, instant fan-out of hot reloads):

```sh
npx -y mcp-tools-controller serve --http --port 3000   # keep running
claude mcp add --transport http mcp-controller http://127.0.0.1:3000/mcp
```

Then in Claude Code, `/mcp` shows the `mcp-controller` server with all aggregated tools. Ask the model to call `plugin_list` to see plugin health, or `plugin_add` to wire in a new MCP server mid-conversation — see the [Agent Guide](./docs/AGENT_GUIDE.md), which is written to be pasted into a model's context.

## File formats

`plugins.json` (registry):

```json
{
  "version": 1,
  "plugins": {
    "demo": {
      "transport": "stdio",
      "command": "node",
      "args": ["dist/examples/demo-server.js"],
      "enabled": true,
      "addedAt": "2026-06-12T15:00:00.000Z",
      "validation": {
        "ok": true,
        "validatedAt": "2026-06-12T15:00:01.000Z",
        "serverName": "demo-server",
        "serverVersion": "1.0.0",
        "protocolVersion": "2025-06-18",
        "toolCount": 3,
        "toolNames": ["echo", "add", "now"]
      }
    }
  }
}
```

`audit.log` (JSONL, append-only):

```json
{"ts":"2026-06-12T15:00:01.000Z","event":"plugin.add","actor":"cli","plugin":"demo","ok":true,"detail":{"transport":"stdio","command":"node"}}
{"ts":"2026-06-12T15:01:12.000Z","event":"tool.call","actor":"gateway","plugin":"demo","ok":true,"detail":{"tool":"add","durationMs":12}}
```

## Development

```sh
task build      # compile
task dev        # compile in watch mode
task e2e        # build + end-to-end suite (aggregation, both hot-reload paths, failure handling, audit)
task demo       # run the bundled demo MCP server standalone
task start      # gateway on stdio
task serve:http # gateway on http://127.0.0.1:3000/mcp
```

## License

MIT
