export type TransportKind = "stdio" | "http";

/**
 * A plugin is one downstream MCP server. The stdio fields mirror Claude Code's
 * .mcp.json entry shape ({ command, args, env }) so configs can be imported
 * and exported without translation.
 */
export interface PluginConfig {
  transport: TransportKind;
  // stdio
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  // http (Streamable HTTP endpoint)
  url?: string;
  headers?: Record<string, string>;
  // management
  enabled: boolean;
  addedAt: string; // ISO 8601
  validation?: ValidationRecord;
}

export interface ValidationRecord {
  ok: boolean;
  validatedAt: string; // ISO 8601
  serverName?: string;
  serverVersion?: string;
  protocolVersion?: string;
  toolCount?: number;
  toolNames?: string[];
  error?: string;
}

export interface RegistryFile {
  version: 1;
  plugins: Record<string, PluginConfig>;
}

/** A downstream tool re-exposed under the gateway's namespace. */
export interface NamespacedTool {
  name: string; // "demo__echo"
  pluginName: string; // "demo"
  originalName: string; // "echo"
  description?: string;
  inputSchema: Record<string, unknown>; // raw JSON Schema, passed through verbatim
  outputSchema?: Record<string, unknown>;
  annotations?: Record<string, unknown>;
}

export type PluginState = "connecting" | "ready" | "error" | "disabled";

export interface PluginStatus {
  name: string;
  state: PluginState;
  transport: TransportKind;
  enabled: boolean;
  toolCount: number;
  tools: string[];
  error?: string;
  validation?: ValidationRecord;
}

export type Actor = "cli" | "gateway" | "mcp-tool";

export const NAMESPACE_SEPARATOR = "__";

/**
 * Plugin names may not contain underscores, so a namespaced tool name
 * ("plugin__tool") always splits unambiguously on the first "__".
 */
export const PLUGIN_NAME_PATTERN = /^[a-z][a-z0-9-]{0,31}$/;

export const TOOL_NAME_PATTERN = /^[a-zA-Z0-9_-]{1,100}$/;

/** Spec-safe budget for a namespaced tool name. */
export const MAX_NAMESPACED_TOOL_NAME = 128;
