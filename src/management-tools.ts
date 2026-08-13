import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import type { PluginManager } from "./plugin-manager.js";
import type { PluginConfig } from "./types.js";

/**
 * Built-in management tools exposed by the gateway itself, so a connected
 * model can add, remove, and hot-reload plugins without shell access.
 *
 * They live in a reserved flat `plugin_*` namespace which can never collide
 * with aggregated tools (those always contain "__").
 */
export const MANAGEMENT_TOOL_NAMES = [
  "plugin_list",
  "plugin_add",
  "plugin_remove",
  "plugin_enable",
  "plugin_disable",
  "plugin_reload",
  "plugin_validate",
  "plugin_tool_schema",
] as const;

export function isManagementTool(name: string): boolean {
  return (MANAGEMENT_TOOL_NAMES as readonly string[]).includes(name);
}

const nameProp = {
  type: "string",
  description: "Plugin name (lowercase letters, digits, hyphens; max 32 chars)",
} as const;

export function managementToolDefs(): Tool[] {
  return [
    {
      name: "plugin_list",
      description:
        "List all registered MCP plugins with their connection state, tool count, last validation result, and last error. Use this first to see what is available.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
    },
    {
      name: "plugin_tool_schema",
      description:
        "Inspect one aggregated tool's exact downstream input/output schemas, compact argument contract, annotations, and a minimal call example. Use this when a client rendered the dynamic schema as a generic object or after INVALID_ARGUMENT.",
      inputSchema: {
        type: "object",
        properties: {
          name: {
            type: "string",
            description: "Full aggregated tool name in '<plugin>__<tool>' form",
          },
        },
        required: ["name"],
        additionalProperties: false,
      },
    },
    {
      name: "plugin_add",
      description:
        "Register and hot-connect a new MCP plugin. The server is validated first (MCP handshake + tools/list); on success its tools become available immediately as '<name>__<tool>' and a tools/list_changed notification is emitted — re-list tools after calling this. For a stdio plugin provide command/args/env; for a remote plugin provide url/headers.",
      inputSchema: {
        type: "object",
        properties: {
          name: nameProp,
          transport: {
            type: "string",
            enum: ["stdio", "http"],
            description: "Defaults to 'stdio' when command is set, 'http' when url is set",
          },
          command: { type: "string", description: "Executable to launch (stdio)" },
          args: { type: "array", items: { type: "string" }, description: "Command arguments" },
          env: {
            type: "object",
            additionalProperties: { type: "string" },
            description: "Extra environment variables for the child process",
          },
          cwd: { type: "string", description: "Working directory for the child process" },
          url: { type: "string", description: "Streamable HTTP endpoint URL (http)" },
          headers: {
            type: "object",
            additionalProperties: { type: "string" },
            description: "Extra HTTP headers, e.g. Authorization",
          },
          skipValidate: {
            type: "boolean",
            description: "Register without validating (not recommended)",
          },
          force: { type: "boolean", description: "Overwrite an existing plugin with the same name" },
        },
        required: ["name"],
        additionalProperties: false,
      },
    },
    {
      name: "plugin_remove",
      description:
        "Disconnect a plugin and remove it from the registry. Its tools disappear immediately and a tools/list_changed notification is emitted.",
      inputSchema: {
        type: "object",
        properties: { name: nameProp },
        required: ["name"],
        additionalProperties: false,
      },
    },
    {
      name: "plugin_enable",
      description: "Re-enable a disabled plugin and reconnect it (config is kept while disabled).",
      inputSchema: {
        type: "object",
        properties: { name: nameProp },
        required: ["name"],
        additionalProperties: false,
      },
    },
    {
      name: "plugin_disable",
      description: "Disconnect a plugin but keep its configuration so it can be re-enabled later.",
      inputSchema: {
        type: "object",
        properties: { name: nameProp },
        required: ["name"],
        additionalProperties: false,
      },
    },
    {
      name: "plugin_reload",
      description:
        "Reconnect a plugin (e.g. after it crashed or was updated). Without a name, re-reads the registry file and reconnects every enabled plugin.",
      inputSchema: {
        type: "object",
        properties: { name: { ...nameProp, description: nameProp.description + " (optional)" } },
        additionalProperties: false,
      },
    },
    {
      name: "plugin_validate",
      description:
        "Re-run the legitimacy check for a plugin (MCP initialize handshake + tools/list) and persist the validation record. Returns the validation report.",
      inputSchema: {
        type: "object",
        properties: { name: nameProp },
        required: ["name"],
        additionalProperties: false,
      },
    },
  ];
}

interface PluginAddArgs {
  name: string;
  transport?: "stdio" | "http";
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  url?: string;
  headers?: Record<string, string>;
  skipValidate?: boolean;
  force?: boolean;
}

export async function handleManagementTool(
  toolName: string,
  args: Record<string, unknown>,
  pm: PluginManager,
): Promise<CallToolResult> {
  try {
    switch (toolName) {
      case "plugin_list":
        return jsonResult({ plugins: pm.getStatus() });

      case "plugin_add": {
        const a = args as unknown as PluginAddArgs;
        if (typeof a.name !== "string") return errorResult("plugin_add requires 'name'.");
        const transport = a.transport ?? (a.url ? "http" : "stdio");
        const cfg: PluginConfig = {
          transport,
          command: a.command,
          args: a.args,
          env: a.env,
          cwd: a.cwd,
          url: a.url,
          headers: a.headers,
          enabled: true,
          addedAt: new Date().toISOString(),
        };
        const validation = await pm.addPlugin(a.name, cfg, "mcp-tool", {
          skipValidate: a.skipValidate,
          force: a.force,
        });
        return jsonResult({
          added: a.name,
          validation,
          note: "Tool list changed — call tools/list again to see the new '" +
            a.name +
            "__*' tools.",
        });
      }

      case "plugin_remove": {
        const name = requireName(args);
        await pm.removePlugin(name, "mcp-tool");
        return jsonResult({ removed: name, note: "Tool list changed." });
      }

      case "plugin_enable": {
        const name = requireName(args);
        await pm.setEnabled(name, true, "mcp-tool");
        return jsonResult({ enabled: name });
      }

      case "plugin_disable": {
        const name = requireName(args);
        await pm.setEnabled(name, false, "mcp-tool");
        return jsonResult({ disabled: name });
      }

      case "plugin_reload": {
        const name = typeof args.name === "string" ? args.name : undefined;
        await pm.reloadPlugin(name, "mcp-tool");
        return jsonResult({
          reloaded: name ?? "all",
          plugins: pm.getStatus().map(({ name: n, state, toolCount }) => ({
            name: n,
            state,
            toolCount,
          })),
        });
      }

      case "plugin_validate": {
        const name = requireName(args);
        const validation = await pm.revalidatePlugin(name, "mcp-tool");
        return jsonResult({ plugin: name, validation });
      }

      case "plugin_tool_schema": {
        const name = requireName(args);
        const schema = pm.getToolSchema(name);
        if (!schema) {
          return errorResult(
            `Unknown aggregated tool '${name}'. Call plugin_list to see current plugin tools.`,
          );
        }
        return jsonResult(schema);
      }

      default:
        return errorResult(`Unknown management tool '${toolName}'.`);
    }
  } catch (err) {
    return errorResult((err as Error).message);
  }
}

function requireName(args: Record<string, unknown>): string {
  if (typeof args.name !== "string" || args.name.length === 0) {
    throw new Error("This tool requires a 'name' argument.");
  }
  return args.name;
}

function jsonResult(value: unknown): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] };
}

function errorResult(text: string): CallToolResult {
  return { isError: true, content: [{ type: "text", text }] };
}
