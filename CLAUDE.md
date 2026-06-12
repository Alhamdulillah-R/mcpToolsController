# CLAUDE.md

MCP Tools Controller: a CLI (`mcpctl`) + MCP aggregation gateway. Downstream MCP servers are "plugins" recorded in a registry file; the gateway proxies their tools as `<plugin>__<tool>` and hot-reloads on registry changes.

## Commands

Task (taskfile.dev) wraps npm scripts 1:1 — use either:

- `task build` / `npm run build` — compile (tsc, NodeNext ESM, output in dist/)
- `task e2e` / `npm run e2e` — build + full end-to-end suite (`src/e2e/run-e2e.ts`). Run this after any change.
- `task demo` — run the sample plugin (`src/examples/demo-server.ts`)
- `task start` / `task serve:http` — run the gateway

## Hard rules

- **Never write to stdout in server code paths.** In stdio serve mode stdout carries JSON-RPC frames; one stray `console.log` corrupts the protocol. Use `src/logger.ts` (stderr only). CLI commands may print to stdout only outside `serve`.
- **SDK version pin:** `@modelcontextprotocol/sdk` is pinned to 1.x. The GitHub `main` branch documents the incompatible 2.0-alpha rewrite (split packages, different transports) — do not copy code from it. Consult the v1.x tag docs or the installed `node_modules` types.
- **Pass-through fidelity:** downstream `inputSchema`/`outputSchema`/`annotations` (tools/list) and `content`/`structuredContent`/`isError` (tools/call) must be forwarded verbatim. This is why the gateway uses the low-level `Server`, not `McpServer`.
- Plugin names forbid underscores (`^[a-z][a-z0-9-]{0,31}$`) so `name__tool` splits unambiguously on the first `__`.
- All user-facing strings are English (the package is published to npm).

## File map

- `src/cli.ts` — commander entry, all subcommands (bin: `mcpctl`)
- `src/plugin-manager.ts` — connection lifecycle, registry diffing, reconnect backoff, tool dispatch (the hot-reload core)
- `src/gateway.ts` — gateway `Server` factory (one per transport/session); `src/http-server.ts` — Streamable HTTP front-end, session map
- `src/registry.ts` — atomic save, directory watcher (debounce + self-write hash suppression)
- `src/validator.ts` — plugin legitimacy check (handshake, capability, tool inventory)
- `src/management-tools.ts` — built-in `plugin_*` MCP tools
- `src/audit.ts` — JSONL audit logger; `src/paths.ts` — registry path resolution
- `docs/AGENT_GUIDE.md` — model-facing manual; keep it in sync when management tools change
