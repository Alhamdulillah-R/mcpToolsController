/**
 * End-to-end test: exercises the CLI, the aggregation gateway, both hot-reload
 * paths (external CLI write + built-in management tool), failure handling, and
 * the audit trail. Exits non-zero on the first failure.
 */
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ToolListChangedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const distRoot = path.resolve(here, "..");
const cliJs = path.join(distRoot, "cli.js");
const demoJs = path.join(distRoot, "examples", "demo-server.js");

const tmp = mkdtempSync(path.join(tmpdir(), "mcpctl-e2e-"));
const registry = path.join(tmp, "plugins.json");
const auditLog = path.join(tmp, "audit.log");

let failures = 0;
function check(name: string, cond: boolean, extra?: string): void {
  if (cond) {
    console.log(`  PASS  ${name}`);
  } else {
    failures += 1;
    console.error(`  FAIL  ${name}${extra ? ` — ${extra}` : ""}`);
  }
}

function cli(...args: string[]): string {
  return execFileSync(process.execPath, [cliJs, "--registry", registry, ...args], {
    encoding: "utf8",
  });
}

function resourceText(result: { contents: unknown[] }): string {
  return result.contents
    .map((c) => (c as { text?: string }).text ?? "")
    .join("");
}

function textOf(result: unknown): string {
  const content = (result as { content?: Array<{ type: string; text?: string }> }).content ?? [];
  return content
    .filter((c) => c.type === "text")
    .map((c) => c.text ?? "")
    .join("\n");
}

// Resolves the next time the gateway sends tools/list_changed.
let nextListChanged: (() => void) | undefined;
function waitForListChanged(timeoutMs = 5_000): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`tools/list_changed not received within ${timeoutMs}ms`)),
      timeoutMs,
    );
    nextListChanged = () => {
      clearTimeout(timer);
      nextListChanged = undefined;
      resolve();
    };
  });
}

async function main(): Promise<void> {
  console.log(`e2e: registry at ${registry}`);

  // 1. CLI add + validation
  console.log("\n[1] CLI add with validation");
  const addOut = cli("add", "demo", "--", process.execPath, demoJs);
  check("add prints validation summary", addOut.includes("4 tool(s)"), addOut);
  const reg1 = JSON.parse(readFileSync(registry, "utf8"));
  check("registry has validation.ok", reg1.plugins.demo?.validation?.ok === true);
  check("registry records 4 tools", reg1.plugins.demo?.validation?.toolCount === 4);

  // 2. Connect a client to the gateway over stdio
  console.log("\n[2] gateway aggregation over stdio");
  const client = new Client({ name: "e2e-client", version: "1.0.0" });
  client.setNotificationHandler(ToolListChangedNotificationSchema, () => {
    nextListChanged?.();
  });
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [cliJs, "--registry", registry, "serve"],
      stderr: "pipe",
    }),
  );

  const list1 = await client.listTools();
  const names1 = list1.tools.map((t) => t.name);
  check(
    "aggregated demo tools present",
    ["demo__echo", "demo__add", "demo__now"].every((n) => names1.includes(n)),
    names1.join(","),
  );
  check(
    "management tools present",
    ["plugin_list", "plugin_add", "plugin_remove", "plugin_reload"].every((n) =>
      names1.includes(n),
    ),
  );
  const demoAdd = list1.tools.find((t) => t.name === "demo__add");
  check("outputSchema passed through", demoAdd?.outputSchema !== undefined);
  const sourceStatus = list1.tools.find((t) => t.name === "demo__source_status");
  check(
    "compact input contract is appended to dynamic tool description",
    sourceStatus?.description?.includes("namespace:string") === true &&
      sourceStatus?.description?.includes("source_id?:string") === true,
  );

  // 2b. Self-management capability delivered to the model
  console.log("\n[2b] self-management capability (instructions + resources)");
  const instructions = client.getInstructions() ?? "";
  check("instructions delivered on initialize", instructions.length > 0);
  check(
    "instructions advertise self-management",
    instructions.includes("plugin_add") && instructions.includes("tools/list_changed"),
    instructions.slice(0, 80),
  );
  const resourceList = await client.listResources();
  const resourceUris = resourceList.resources.map((r) => r.uri);
  check(
    "guide + plugins resources listed",
    ["mcp-controller://agent-guide", "mcp-controller://plugins"].every((u) =>
      resourceUris.includes(u),
    ),
    resourceUris.join(","),
  );
  const guideRes = await client.readResource({ uri: "mcp-controller://agent-guide" });
  check("agent-guide resource readable", resourceText(guideRes).includes("plugin_add"));
  const pluginsRes = await client.readResource({ uri: "mcp-controller://plugins" });
  check(
    "plugins resource is live JSON with demo",
    JSON.parse(resourceText(pluginsRes) || "{}").plugins?.some(
      (p: { name: string }) => p.name === "demo",
    ) === true,
  );
  let unknownResourceRejected = false;
  try {
    await client.readResource({ uri: "mcp-controller://nope" });
  } catch {
    unknownResourceRejected = true;
  }
  check("unknown resource rejected without crashing", unknownResourceRejected);

  // 3. Proxied call with structured content
  console.log("\n[3] proxied tool call");
  const sum = await client.callTool({ name: "demo__add", arguments: { a: 2, b: 3 } });
  check("demo__add returns 5", textOf(sum).trim() === "5", JSON.stringify(sum));
  check(
    "structuredContent passed through",
    JSON.stringify((sum as { structuredContent?: unknown }).structuredContent) === '{"sum":5}',
  );

  const schemaRes = await client.callTool({
    name: "plugin_tool_schema",
    arguments: { name: "demo__source_status" },
  });
  check(
    "plugin_tool_schema exposes exact schema and example",
    textOf(schemaRes).includes('"inputSchema"') && textOf(schemaRes).includes('"namespace"'),
    textOf(schemaRes),
  );
  const invalidArgs = await client.callTool({
    name: "demo__source_status",
    arguments: { namespace: "demo", source_path: "D:\\trace.json" },
  });
  check(
    "invalid arguments include source_path -> path suggestion",
    (invalidArgs as { isError?: boolean }).isError === true &&
      textOf(invalidArgs).includes('"suggestion": "path"'),
    textOf(invalidArgs),
  );

  // 4. Hot reload via external CLI write
  console.log("\n[4] hot reload: external CLI add while gateway is running");
  const changed1 = waitForListChanged();
  cli("add", "demo2", "--", process.execPath, demoJs);
  await changed1;
  const list2 = await client.listTools();
  check(
    "demo2 tools appeared without restart",
    list2.tools.some((t) => t.name === "demo2__echo"),
  );

  // 5. Hot reload via built-in management tool
  console.log("\n[5] hot reload: plugin_remove via management tool");
  const changed2 = waitForListChanged();
  const removeRes = await client.callTool({ name: "plugin_remove", arguments: { name: "demo2" } });
  check("plugin_remove succeeds", (removeRes as { isError?: boolean }).isError !== true);
  await changed2;
  const list3 = await client.listTools();
  check(
    "demo2 tools gone after plugin_remove",
    !list3.tools.some((t) => t.name.startsWith("demo2__")),
  );
  const reg2 = JSON.parse(readFileSync(registry, "utf8"));
  check("registry file no longer contains demo2 (write-through)", !("demo2" in reg2.plugins));

  // 6. Failure path: invalid plugin must not break the gateway
  console.log("\n[6] failure path: plugin_add with a bogus command");
  const badRes = await client.callTool({
    name: "plugin_add",
    arguments: { name: "bogus", command: "definitely-not-a-binary-xyz" },
  });
  check("bogus add returns isError", (badRes as { isError?: boolean }).isError === true);
  const statusRes = await client.callTool({ name: "plugin_list", arguments: {} });
  check("gateway still alive (plugin_list works)", textOf(statusRes).includes('"demo"'));

  // 7. plugin_validate via management tool
  console.log("\n[7] plugin_validate via management tool");
  const valRes = await client.callTool({ name: "plugin_validate", arguments: { name: "demo" } });
  check("plugin_validate reports ok", textOf(valRes).includes('"ok": true'), textOf(valRes));

  await client.close();

  // 8. stdio<->HTTP bridge (the Claude Desktop path for a shared gateway)
  console.log("\n[8] connect bridge: stdio client -> bridge -> HTTP gateway");
  const port = 30000 + Math.floor(Math.random() * 10000);
  const httpGateway = spawn(
    process.execPath,
    [cliJs, "--registry", registry, "serve", "--http", "--port", String(port)],
    { stdio: ["ignore", "ignore", "pipe"] },
  );
  try {
    await new Promise((r) => setTimeout(r, 1200)); // let it bind + connect plugins

    const bridged = new Client({ name: "e2e-bridge-client", version: "1.0.0" });
    bridged.setNotificationHandler(ToolListChangedNotificationSchema, () => {
      nextListChanged?.();
    });
    await bridged.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: [cliJs, "connect", `http://127.0.0.1:${port}/mcp`],
        stderr: "pipe",
      }),
    );
    const bridgedList = await bridged.listTools();
    check(
      "tools visible through the bridge",
      bridgedList.tools.some((t) => t.name === "demo__add"),
      bridgedList.tools.map((t) => t.name).join(","),
    );
    const bridgedSum = await bridged.callTool({ name: "demo__add", arguments: { a: 4, b: 6 } });
    check("tool call through the bridge", textOf(bridgedSum).trim() === "10");

    // Hot reload must traverse gateway SSE -> bridge -> stdio client.
    const changedViaBridge = waitForListChanged(8_000);
    cli("add", "demo3", "--", process.execPath, demoJs);
    await changedViaBridge;
    const bridgedList2 = await bridged.listTools();
    check(
      "list_changed propagates through the bridge",
      bridgedList2.tools.some((t) => t.name === "demo3__echo"),
    );
    cli("remove", "demo3");
    await bridged.close();
  } finally {
    httpGateway.kill("SIGTERM");
  }

  // 9. Audit trail
  console.log("\n[9] audit trail");
  const audit = readFileSync(auditLog, "utf8");
  for (const event of ["plugin.add", "tool.call", "plugin.remove", "plugin.connect"]) {
    check(`audit log contains ${event}`, audit.includes(`"event":"${event}"`));
  }
  check(
    "audit distinguishes mcp-tool actor",
    audit.includes('"actor":"mcp-tool"'),
  );

  console.log(failures === 0 ? "\nAll e2e checks passed." : `\n${failures} check(s) FAILED.`);
  process.exit(failures === 0 ? 0 : 1);
}

main()
  .catch((err) => {
    console.error(`e2e crashed: ${err instanceof Error ? err.stack : String(err)}`);
    process.exit(1);
  })
  .finally(() => {
    rmSync(tmp, { recursive: true, force: true });
  });
