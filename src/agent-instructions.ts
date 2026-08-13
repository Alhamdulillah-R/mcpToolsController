import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** Resource the model can read to get the full agent-facing manual. */
export const GUIDE_RESOURCE_URI = "mcp-controller://agent-guide";
/** Resource the model can read to get the live plugin status snapshot. */
export const PLUGINS_RESOURCE_URI = "mcp-controller://plugins";

/**
 * Instructions delivered to the model in the MCP `initialize` response, so a
 * connected model automatically learns it can manage its own MCP plugins —
 * no need for a human to paste the guide into context.
 */
export function buildServerInstructions(management: boolean): string {
  if (!management) {
    return [
      "You are connected to the MCP Tools Controller — an aggregation gateway that",
      "re-exposes the tools of several downstream MCP servers ('plugins') through one",
      "endpoint. Aggregated tools are named '<plugin>__<tool>' (double underscore);",
      "split on the first '__' to see which plugin a tool belongs to.",
      "",
      "Self-management tools are disabled on this gateway, so you cannot add or remove",
      `plugins. Read the resource '${GUIDE_RESOURCE_URI}' for the full manual.`,
    ].join("\n");
  }

  return [
    "You are connected to the MCP Tools Controller — an aggregation gateway that",
    "re-exposes the tools of several downstream MCP servers ('plugins') through one",
    "endpoint, and lets you manage those plugins yourself at runtime.",
    "",
    "Aggregated tools are named '<plugin>__<tool>' (double underscore). The flat",
    "'plugin_*' tools below are the gateway's own controls — use them to wire MCP",
    "servers in and out for yourself:",
    "",
    "  plugin_list      — see all plugins, their health, and their tools (start here)",
    "  plugin_add       — connect a new MCP server (validated first); its tools appear as <name>__*",
    "  plugin_remove    — disconnect and deregister a plugin",
    "  plugin_enable    — re-enable a disabled plugin",
    "  plugin_disable   — disconnect a plugin but keep its config",
    "  plugin_reload    — reconnect a plugin (use after it crashed or was updated)",
    "  plugin_validate  — re-run the legitimacy check for a plugin",
    "  plugin_tool_schema — inspect an aggregated tool's exact schema and example",
    "",
    "After any change (plugin_add / plugin_remove / enable / disable / reload), the",
    "gateway emits notifications/tools/list_changed. Re-list tools before assuming the",
    "old set is still valid; new plugin tools appear as '<plugin>__<tool>'.",
    "",
    "If a tool call returns an error saying its plugin is unavailable, call",
    "plugin_reload with that plugin's name, then retry.",
    "If a tool call returns INVALID_ARGUMENT, apply its field suggestion or call",
    "plugin_tool_schema with the full '<plugin>__<tool>' name before retrying.",
    "",
    `Read '${GUIDE_RESOURCE_URI}' for the full manual (schemas, examples, error table),`,
    `and '${PLUGINS_RESOURCE_URI}' for a live JSON snapshot of plugin status.`,
  ].join("\n");
}

/**
 * Load the full agent guide shipped with the package (docs/AGENT_GUIDE.md sits
 * next to dist/ at the package root and is included via package.json "files").
 * Falls back to the inline instructions if the file can't be read.
 */
export async function loadAgentGuide(): Promise<string> {
  const guidePath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "docs", "AGENT_GUIDE.md");
  try {
    return await readFile(guidePath, "utf8");
  } catch {
    return buildServerInstructions(true);
  }
}
