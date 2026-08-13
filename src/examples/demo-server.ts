#!/usr/bin/env node
/**
 * Minimal demo MCP server used as the "first plugin" in the README and by the
 * end-to-end tests. Exposes four tools: echo, add, source_status, and now.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const server = new McpServer({ name: "demo-server", version: "1.0.0" });

server.registerTool(
  "echo",
  {
    description: "Echo a message back",
    inputSchema: { message: z.string().describe("Message to echo") },
  },
  async ({ message }) => ({
    content: [{ type: "text", text: `echo: ${message}` }],
  }),
);

server.registerTool(
  "add",
  {
    description: "Add two numbers",
    inputSchema: {
      a: z.number().describe("First number"),
      b: z.number().describe("Second number"),
    },
    outputSchema: { sum: z.number() },
  },
  async ({ a, b }) => {
    const sum = a + b;
    return {
      content: [{ type: "text", text: String(sum) }],
      structuredContent: { sum },
    };
  },
);

server.registerTool(
  "source_status",
  {
    description: "Inspect one source by path or source ID",
    inputSchema: {
      namespace: z.string(),
      path: z.string().optional(),
      source_id: z.string().optional(),
    },
  },
  async ({ namespace, path, source_id }) => ({
    content: [{ type: "text", text: JSON.stringify({ namespace, path, source_id }) }],
  }),
);

server.registerTool(
  "now",
  { description: "Get the current time in ISO 8601 format", inputSchema: {} },
  async () => ({
    content: [{ type: "text", text: new Date().toISOString() }],
  }),
);

const transport = new StdioServerTransport();
await server.connect(transport);
