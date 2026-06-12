import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
  isJSONRPCRequest,
  type JSONRPCMessage,
} from "@modelcontextprotocol/sdk/types.js";
import { log } from "./logger.js";

/**
 * stdio <-> Streamable HTTP bridge.
 *
 * Some clients (notably Claude Desktop) can only launch stdio MCP servers.
 * This bridge lets them share a long-running HTTP gateway anyway: the client
 * spawns `mcpctl connect <url>`, and every JSON-RPC message is pumped through
 * verbatim in both directions. The HTTP client transport manages the session
 * itself based on the traffic (captures mcp-session-id on initialize, opens
 * the SSE notification stream after the initialized notification), so hot
 * reload notifications from the gateway reach the client unchanged.
 */
export async function runStdioBridge(
  url: string,
  headers?: Record<string, string>,
): Promise<void> {
  const remote = new StreamableHTTPClientTransport(new URL(url), {
    requestInit: headers ? { headers } : undefined,
  });
  const local = new StdioServerTransport();

  let shuttingDown = false;
  const shutdown = async (code: number): Promise<never> => {
    shuttingDown = true;
    await Promise.allSettled([remote.close(), local.close()]);
    process.exit(code);
  };

  remote.onmessage = (message: JSONRPCMessage) => {
    void local.send(message).catch((err) => {
      log.error(`bridge: failed to write to stdio: ${String(err)}`);
    });
  };
  local.onmessage = (message: JSONRPCMessage) => {
    void remote.send(message).catch((err) => {
      log.error(`bridge: failed to reach gateway at ${url}: ${String(err)}`);
      // Don't leave the client hanging on a request: answer with a JSON-RPC error.
      if (isJSONRPCRequest(message)) {
        void local
          .send({
            jsonrpc: "2.0",
            id: message.id,
            error: {
              code: -32001,
              message: `Gateway unreachable at ${url}: ${(err as Error).message}`,
            },
          })
          .catch(() => {});
      }
    });
  };

  remote.onerror = (err) => log.warn(`bridge: gateway transport error: ${String(err)}`);
  local.onerror = (err) => log.warn(`bridge: stdio transport error: ${String(err)}`);
  remote.onclose = () => {
    if (!shuttingDown) {
      log.error("bridge: gateway connection closed; exiting");
      void shutdown(1);
    }
  };
  // Client closed stdin (e.g. Claude Desktop quitting): exit cleanly.
  local.onclose = () => {
    if (!shuttingDown) void shutdown(0);
  };

  await remote.start();
  await local.start();
  log.info(`bridge ready: stdio <-> ${url}`);
}
