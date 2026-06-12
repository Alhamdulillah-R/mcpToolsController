import { randomUUID } from "node:crypto";
import http from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createGatewayServer, type GatewayOptions } from "./gateway.js";
import { log } from "./logger.js";
import type { PluginManager } from "./plugin-manager.js";

const MCP_PATH = "/mcp";

interface Session {
  transport: StreamableHTTPServerTransport;
  dispose: () => void;
}

/**
 * Streamable HTTP front-end for the gateway. One long-running process serves
 * many clients; each MCP session gets its own Server instance (1.x binding is
 * one transport per Server) wired to the shared PluginManager, so hot reloads
 * broadcast tools/list_changed to every connected session at once.
 */
export function startHttpServer(
  pm: PluginManager,
  opts: GatewayOptions & { port: number; host?: string },
): http.Server {
  const sessions = new Map<string, Session>();

  const httpServer = http.createServer((req, res) => {
    void handle(req, res).catch((err) => {
      log.error(`http handler error: ${String(err)}`);
      if (!res.headersSent) {
        res.writeHead(500, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            jsonrpc: "2.0",
            error: { code: -32603, message: "Internal server error" },
            id: null,
          }),
        );
      }
    });
  });

  async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    if (url.pathname !== MCP_PATH) {
      res.writeHead(404, { "content-type": "text/plain" });
      res.end(`Not found. The MCP endpoint is ${MCP_PATH}`);
      return;
    }

    const sessionId = req.headers["mcp-session-id"] as string | undefined;

    if (req.method === "POST") {
      const body = await readJsonBody(req);
      if (sessionId && sessions.has(sessionId)) {
        await sessions.get(sessionId)!.transport.handleRequest(req, res, body);
        return;
      }
      if (!sessionId && isInitializeRequest(body)) {
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (id) => {
            sessions.set(id, { transport, dispose });
            log.info(`http session ${id} opened (${sessions.size} active)`);
          },
        });
        const { server, dispose } = createGatewayServer(pm, opts);
        transport.onclose = () => {
          const id = transport.sessionId;
          if (id && sessions.has(id)) {
            sessions.get(id)!.dispose();
            sessions.delete(id);
            log.info(`http session ${id} closed (${sessions.size} active)`);
          }
        };
        await server.connect(transport);
        await transport.handleRequest(req, res, body);
        return;
      }
      res.writeHead(400, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          jsonrpc: "2.0",
          error: { code: -32000, message: "Bad request: missing or unknown mcp-session-id" },
          id: null,
        }),
      );
      return;
    }

    // GET opens the SSE notification stream (required for list_changed
    // delivery); DELETE terminates the session.
    if (req.method === "GET" || req.method === "DELETE") {
      if (!sessionId || !sessions.has(sessionId)) {
        res.writeHead(400, { "content-type": "text/plain" });
        res.end("Missing or unknown mcp-session-id header");
        return;
      }
      await sessions.get(sessionId)!.transport.handleRequest(req, res);
      return;
    }

    res.writeHead(405, { allow: "GET, POST, DELETE" });
    res.end();
  }

  httpServer.listen(opts.port, opts.host ?? "127.0.0.1", () => {
    log.info(
      `gateway listening on http://${opts.host ?? "127.0.0.1"}:${opts.port}${MCP_PATH} (Streamable HTTP)`,
    );
  });
  return httpServer;
}

async function readJsonBody(req: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const raw = Buffer.concat(chunks).toString("utf8");
  if (raw.length === 0) return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

function isInitializeRequest(body: unknown): boolean {
  const check = (msg: unknown): boolean =>
    typeof msg === "object" && msg !== null && (msg as { method?: string }).method === "initialize";
  return Array.isArray(body) ? body.some(check) : check(body);
}
