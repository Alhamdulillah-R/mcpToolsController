import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import { log } from "./logger.js";
import {
  handleManagementTool,
  isManagementTool,
  managementToolDefs,
} from "./management-tools.js";
import type { PluginManager } from "./plugin-manager.js";
import type { NamespacedTool } from "./types.js";

export const GATEWAY_NAME = "mcp-tools-controller";
export const GATEWAY_VERSION = "0.1.0";

export interface GatewayOptions {
  /** Expose the built-in plugin_* management tools (default true). */
  management: boolean;
}

/**
 * Create one gateway MCP server instance bound to the shared PluginManager.
 *
 * This is a factory, not a singleton: in Streamable HTTP mode each session
 * needs its own Server (a 1.x Server binds to exactly one transport). Every
 * instance subscribes to the manager's "tools-changed" event and forwards it
 * as notifications/tools/list_changed; callers must invoke the returned
 * dispose() when the transport closes.
 */
export function createGatewayServer(
  pm: PluginManager,
  opts: GatewayOptions,
): { server: Server; dispose: () => void } {
  const server = new Server(
    { name: GATEWAY_NAME, version: GATEWAY_VERSION },
    // listChanged is required, otherwise sendToolListChanged() throws.
    { capabilities: { tools: { listChanged: true } } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      ...(opts.management ? managementToolDefs() : []),
      ...pm.getTools().map(toToolListEntry),
    ],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name, arguments: args } = req.params;
    if (isManagementTool(name)) {
      if (!opts.management) {
        return {
          isError: true,
          content: [{ type: "text", text: "Management tools are disabled on this gateway." }],
        };
      }
      return handleManagementTool(name, args ?? {}, pm);
    }
    return pm.callTool(name, (args ?? {}) as Record<string, unknown>);
  });

  const onToolsChanged = (): void => {
    server.sendToolListChanged().catch((err) => {
      log.warn(`failed to send tools/list_changed: ${String(err)}`);
    });
  };
  pm.on("tools-changed", onToolsChanged);

  return {
    server,
    dispose(): void {
      pm.off("tools-changed", onToolsChanged);
    },
  };
}

/** Pass downstream schemas through verbatim — no lossy conversion. */
function toToolListEntry(tool: NamespacedTool): Tool {
  return {
    name: tool.name,
    description: tool.description
      ? `[${tool.pluginName}] ${tool.description}`
      : `Tool '${tool.originalName}' from plugin '${tool.pluginName}'`,
    inputSchema: tool.inputSchema as Tool["inputSchema"],
    ...(tool.outputSchema ? { outputSchema: tool.outputSchema as Tool["outputSchema"] } : {}),
    ...(tool.annotations ? { annotations: tool.annotations as Tool["annotations"] } : {}),
  };
}
