import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { buildClientTransport } from "./transport.js";
import {
  MAX_NAMESPACED_TOOL_NAME,
  NAMESPACE_SEPARATOR,
  PLUGIN_NAME_PATTERN,
  TOOL_NAME_PATTERN,
  type PluginConfig,
  type ValidationRecord,
} from "./types.js";

export const DEFAULT_VALIDATE_TIMEOUT_MS = 15_000;

/** Static checks that don't require connecting. Throws with a clear message. */
export function staticValidate(name: string, cfg: PluginConfig): void {
  if (!PLUGIN_NAME_PATTERN.test(name)) {
    throw new Error(
      `Invalid plugin name '${name}'. Names must match ${PLUGIN_NAME_PATTERN} ` +
        `(lowercase letters, digits and hyphens; no underscores — they are reserved for tool namespacing).`,
    );
  }
  if (cfg.transport === "stdio" && !cfg.command) {
    throw new Error(`Plugin '${name}': stdio transport requires a command. Provide it after '--'.`);
  }
  if (cfg.transport === "http") {
    if (!cfg.url) throw new Error(`Plugin '${name}': http transport requires --url.`);
    try {
      new URL(cfg.url);
    } catch {
      throw new Error(`Plugin '${name}': invalid url '${cfg.url}'.`);
    }
  }
}

/**
 * Legitimacy check for a plugin: connect (full MCP initialize handshake),
 * require the tools capability, list all tools (following pagination), and
 * verify tool names are spec-safe within our namespace budget.
 *
 * The connection is always closed afterwards; a hung child is killed by the
 * SDK's stdin-close -> SIGTERM -> SIGKILL escalation.
 */
export async function validatePlugin(
  name: string,
  cfg: PluginConfig,
  opts: { timeoutMs?: number } = {},
): Promise<ValidationRecord> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_VALIDATE_TIMEOUT_MS;
  const validatedAt = new Date().toISOString();

  try {
    staticValidate(name, cfg);
  } catch (err) {
    return { ok: false, validatedAt, error: (err as Error).message };
  }

  const client = new Client({ name: "mcp-tools-controller-validator", version: "1.0.0" });
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`Validation timed out after ${timeoutMs}ms`)),
      timeoutMs,
    );
  });

  try {
    const run = async (): Promise<ValidationRecord> => {
      const transport = buildClientTransport(name, cfg);
      // The client calls this hook with the negotiated protocol version
      // right after a successful initialize handshake.
      let negotiatedProtocol: string | undefined;
      const originalSet = transport.setProtocolVersion?.bind(transport);
      transport.setProtocolVersion = (version: string) => {
        negotiatedProtocol = version;
        originalSet?.(version);
      };
      await client.connect(transport);

      const serverInfo = client.getServerVersion();
      const capabilities = client.getServerCapabilities();
      if (!capabilities?.tools) {
        throw new Error(
          `Server connected but does not advertise the 'tools' capability; nothing to aggregate.`,
        );
      }

      const toolNames: string[] = [];
      let cursor: string | undefined;
      do {
        const page = await client.listTools(cursor ? { cursor } : {});
        for (const tool of page.tools) {
          if (!TOOL_NAME_PATTERN.test(tool.name)) {
            throw new Error(`Tool name '${tool.name}' contains unsupported characters.`);
          }
          const namespaced = `${name}${NAMESPACE_SEPARATOR}${tool.name}`;
          if (namespaced.length > MAX_NAMESPACED_TOOL_NAME) {
            throw new Error(
              `Namespaced tool name '${namespaced}' exceeds ${MAX_NAMESPACED_TOOL_NAME} characters.`,
            );
          }
          toolNames.push(tool.name);
        }
        cursor = page.nextCursor;
      } while (cursor);

      return {
        ok: true,
        validatedAt,
        serverName: serverInfo?.name,
        serverVersion: serverInfo?.version,
        protocolVersion: negotiatedProtocol,
        toolCount: toolNames.length,
        toolNames,
      };
    };

    return await Promise.race([run(), timeout]);
  } catch (err) {
    return { ok: false, validatedAt, error: (err as Error).message };
  } finally {
    if (timer) clearTimeout(timer);
    await client.close().catch(() => {});
  }
}
