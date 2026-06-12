#!/usr/bin/env node
import { execFileSync, spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Command } from "commander";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { AuditLogger } from "./audit.js";
import { GATEWAY_VERSION } from "./gateway.js";
import { log } from "./logger.js";
import { auditPathFor, resolveRegistryPath } from "./paths.js";
import { PluginManager } from "./plugin-manager.js";
import { loadRegistry, saveRegistry } from "./registry.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createGatewayServer } from "./gateway.js";
import { startHttpServer } from "./http-server.js";
import { buildClientTransport } from "./transport.js";
import { staticValidate, validatePlugin } from "./validator.js";
import type { PluginConfig } from "./types.js";

const program = new Command();

program
  .name("mcpctl")
  .enablePositionalOptions()
  .description(
    "MCP Tools Controller — manage MCP servers as plugins and aggregate them behind one hot-reloading MCP gateway.",
  )
  .version(GATEWAY_VERSION)
  .option("--registry <path>", "Path to the plugin registry file (default: ~/.mcp-controller/plugins.json)");

interface GlobalOpts {
  registry?: string;
}

function ctx(): { registryPath: string; audit: AuditLogger } {
  const opts = program.opts<GlobalOpts>();
  const registryPath = resolveRegistryPath(opts.registry);
  return { registryPath, audit: new AuditLogger(auditPathFor(registryPath)) };
}

function fail(message: string): never {
  process.stderr.write(`Error: ${message}\n`);
  process.exit(1);
}

function parseKeyValues(pairs: string[], flag: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const pair of pairs) {
    const eq = pair.indexOf("=");
    if (eq <= 0) fail(`Invalid ${flag} value '${pair}', expected KEY=VALUE`);
    out[pair.slice(0, eq)] = pair.slice(eq + 1);
  }
  return out;
}

// ---------------------------------------------------------------- add

program
  .command("add")
  .description("Register a new MCP plugin. stdio: mcpctl add <name> -- <command> [args...]; http: mcpctl add <name> --url <endpoint>")
  .argument("<name>", "Plugin name (lowercase letters, digits, hyphens)")
  .argument("[commandAndArgs...]", "Launch command for the plugin's MCP server, after '--'")
  .option("--url <url>", "Streamable HTTP endpoint of a remote MCP server")
  .option("--header <KEY=VALUE...>", "HTTP header for --url plugins (repeatable)", (v: string, p: string[]) => [...p, v], [] as string[])
  .option("--env <KEY=VALUE...>", "Environment variable for the child process (repeatable)", (v: string, p: string[]) => [...p, v], [] as string[])
  .option("--cwd <dir>", "Working directory for the child process")
  .option("--skip-validate", "Register without running the validation handshake")
  .option("--force", "Overwrite an existing plugin with the same name")
  .passThroughOptions()
  .action(async (name: string, commandAndArgs: string[], opts) => {
    const { registryPath, audit } = ctx();
    // commander passes the '--' separator through; drop it.
    const launch = commandAndArgs[0] === "--" ? commandAndArgs.slice(1) : commandAndArgs;
    const [command, ...args] = launch;
    const cfg: PluginConfig = {
      transport: opts.url ? "http" : "stdio",
      command,
      args: args.length > 0 ? args : undefined,
      env: opts.env.length > 0 ? parseKeyValues(opts.env, "--env") : undefined,
      cwd: opts.cwd,
      url: opts.url,
      headers: opts.header.length > 0 ? parseKeyValues(opts.header, "--header") : undefined,
      enabled: true,
      addedAt: new Date().toISOString(),
    };

    try {
      staticValidate(name, cfg);
    } catch (err) {
      fail((err as Error).message);
    }

    const reg = await loadRegistry(registryPath);
    if (reg.plugins[name] && !opts.force) {
      fail(`Plugin '${name}' already exists. Use --force to overwrite.`);
    }

    if (opts.skipValidate) {
      cfg.validation = { ok: false, validatedAt: new Date().toISOString(), error: "validation skipped" };
      process.stdout.write(`Skipping validation for '${name}' (--skip-validate)\n`);
    } else {
      process.stdout.write(`Validating '${name}' (MCP handshake + tools/list)...\n`);
      const validation = await validatePlugin(name, cfg);
      cfg.validation = validation;
      if (!validation.ok) {
        audit.log("plugin.add", "cli", { plugin: name, ok: false, detail: { error: validation.error } });
        fail(`Validation failed: ${validation.error}`);
      }
      process.stdout.write(
        `Validated: ${validation.serverName ?? "unknown"}@${validation.serverVersion ?? "?"} — ` +
          `${validation.toolCount} tool(s): ${(validation.toolNames ?? []).join(", ")}\n`,
      );
    }

    reg.plugins[name] = cfg;
    await saveRegistry(registryPath, reg);
    audit.log("plugin.add", "cli", {
      plugin: name,
      ok: true,
      detail: { transport: cfg.transport, command: cfg.command, url: cfg.url },
    });
    process.stdout.write(
      `Plugin '${name}' registered in ${registryPath}.\n` +
        `A running gateway will pick it up automatically (hot reload).\n` +
        `Its tools are exposed as '${name}__<tool>'.\n`,
    );
  });

// ---------------------------------------------------------------- remove

program
  .command("remove")
  .description("Remove a plugin from the registry")
  .argument("<name>", "Plugin name")
  .action(async (name: string) => {
    const { registryPath, audit } = ctx();
    const reg = await loadRegistry(registryPath);
    if (!reg.plugins[name]) fail(`Plugin '${name}' is not registered.`);
    delete reg.plugins[name];
    await saveRegistry(registryPath, reg);
    audit.log("plugin.remove", "cli", { plugin: name, ok: true });
    process.stdout.write(
      `Plugin '${name}' removed. A running gateway will disconnect it automatically.\n`,
    );
  });

// ---------------------------------------------------------------- list

program
  .command("list")
  .description("List all registered plugins")
  .option("--json", "Output machine-readable JSON")
  .action(async (opts) => {
    const { registryPath } = ctx();
    const reg = await loadRegistry(registryPath);
    const entries = Object.entries(reg.plugins);

    if (opts.json) {
      process.stdout.write(JSON.stringify({ registry: registryPath, plugins: reg.plugins }, null, 2) + "\n");
      return;
    }
    if (entries.length === 0) {
      process.stdout.write(`No plugins registered (registry: ${registryPath}).\nAdd one with: mcpctl add <name> -- <command> [args...]\n`);
      return;
    }
    process.stdout.write(`Registry: ${registryPath}\n\n`);
    const rows = entries.map(([name, cfg]) => ({
      name,
      transport: cfg.transport,
      enabled: cfg.enabled ? "yes" : "no",
      health: cfg.validation ? (cfg.validation.ok ? "valid" : "invalid") : "unknown",
      tools: cfg.validation?.toolCount ?? "-",
      target: cfg.transport === "http" ? (cfg.url ?? "") : [cfg.command, ...(cfg.args ?? [])].join(" "),
    }));
    const headers = ["NAME", "TRANSPORT", "ENABLED", "VALIDATION", "TOOLS", "TARGET"];
    const widths = headers.map((h, i) =>
      Math.max(h.length, ...rows.map((r) => String(Object.values(r)[i]).length)),
    );
    const line = (cells: (string | number)[]): string =>
      cells.map((c, i) => String(c).padEnd(widths[i])).join("  ") + "\n";
    process.stdout.write(line(headers));
    for (const r of rows) process.stdout.write(line(Object.values(r)));
  });

// ---------------------------------------------------------------- validate

program
  .command("validate")
  .description("Re-run the legitimacy check (MCP handshake + tools/list) for one plugin or all")
  .argument("[name]", "Plugin name")
  .option("--all", "Validate every registered plugin")
  .action(async (name: string | undefined, opts) => {
    const { registryPath, audit } = ctx();
    const reg = await loadRegistry(registryPath);
    const targets = opts.all ? Object.keys(reg.plugins) : name ? [name] : [];
    if (targets.length === 0) fail("Provide a plugin name or --all.");

    let anyFailed = false;
    for (const target of targets) {
      const cfg = reg.plugins[target];
      if (!cfg) fail(`Plugin '${target}' is not registered.`);
      process.stdout.write(`Validating '${target}'... `);
      const validation = await validatePlugin(target, cfg);
      cfg.validation = validation;
      audit.log("plugin.validate", "cli", {
        plugin: target,
        ok: validation.ok,
        detail: validation.ok ? { toolCount: validation.toolCount } : { error: validation.error },
      });
      if (validation.ok) {
        process.stdout.write(`OK (${validation.toolCount} tools: ${(validation.toolNames ?? []).join(", ")})\n`);
      } else {
        anyFailed = true;
        process.stdout.write(`FAILED: ${validation.error}\n`);
      }
    }
    await saveRegistry(registryPath, reg);
    if (anyFailed) process.exit(1);
  });

// ---------------------------------------------------------------- enable / disable

for (const [verb, enabled] of [
  ["enable", true],
  ["disable", false],
] as const) {
  program
    .command(verb)
    .description(`${enabled ? "Enable" : "Disable"} a plugin (a running gateway ${enabled ? "connects" : "disconnects"} it immediately)`)
    .argument("<name>", "Plugin name")
    .action(async (name: string) => {
      const { registryPath, audit } = ctx();
      const reg = await loadRegistry(registryPath);
      const cfg = reg.plugins[name];
      if (!cfg) fail(`Plugin '${name}' is not registered.`);
      cfg.enabled = enabled;
      await saveRegistry(registryPath, reg);
      audit.log(`plugin.${verb}`, "cli", { plugin: name, ok: true });
      process.stdout.write(`Plugin '${name}' ${verb}d.\n`);
    });
}

// ---------------------------------------------------------------- call (one-shot debug)

program
  .command("call")
  .description("Invoke one tool of a plugin directly (spawns/contacts the plugin, no gateway needed)")
  .argument("<plugin>", "Plugin name")
  .argument("<tool>", "Tool name (original, without namespace prefix)")
  .option("--args <json>", "Tool arguments as a JSON object", "{}")
  .action(async (pluginName: string, toolName: string, opts) => {
    const { registryPath } = ctx();
    const reg = await loadRegistry(registryPath);
    const cfg = reg.plugins[pluginName];
    if (!cfg) fail(`Plugin '${pluginName}' is not registered.`);
    let args: Record<string, unknown>;
    try {
      args = JSON.parse(opts.args);
    } catch {
      fail(`--args must be valid JSON, got: ${opts.args}`);
    }
    const client = new Client({ name: "mcpctl-call", version: GATEWAY_VERSION });
    try {
      await client.connect(buildClientTransport(pluginName, cfg));
      const result = await client.callTool({ name: toolName, arguments: args });
      process.stdout.write(JSON.stringify(result, null, 2) + "\n");
    } finally {
      await client.close().catch(() => {});
    }
  });

// ---------------------------------------------------------------- serve

program
  .command("serve")
  .description("Start the aggregation gateway (stdio by default, --http for a shared Streamable HTTP server)")
  .option("--http", "Serve over Streamable HTTP instead of stdio")
  .option("--port <port>", "HTTP port (with --http)", "3000")
  .option("--host <host>", "HTTP bind host (with --http)", "127.0.0.1")
  .option("--no-management", "Do not expose the built-in plugin_* management tools")
  .action(async (opts) => {
    const { registryPath, audit } = ctx();
    const pm = new PluginManager(registryPath, audit);
    audit.log("gateway.start", "gateway", {
      detail: { mode: opts.http ? "http" : "stdio", registry: registryPath },
    });
    await pm.start();

    const shutdown = async (): Promise<void> => {
      audit.log("gateway.stop", "gateway", {});
      await pm.stop();
      process.exit(0);
    };
    process.on("SIGINT", () => void shutdown());
    process.on("SIGTERM", () => void shutdown());

    if (opts.http) {
      startHttpServer(pm, {
        management: opts.management,
        port: Number(opts.port),
        host: opts.host,
      });
      return;
    }

    // stdio mode: stdout belongs to the transport from here on.
    const { server } = createGatewayServer(pm, { management: opts.management });
    await server.connect(new StdioServerTransport());
    log.info(`gateway ready on stdio (registry: ${registryPath})`);
  });

// ---------------------------------------------------------------- import

program
  .command("import")
  .description("Bulk-import plugins from a Claude Code .mcp.json file ({\"mcpServers\": {...}})")
  .argument("<file>", "Path to .mcp.json")
  .option("--skip-validate", "Register without validating each server")
  .action(async (file: string, opts) => {
    const { registryPath, audit } = ctx();
    let parsed: { mcpServers?: Record<string, { command?: string; args?: string[]; env?: Record<string, string>; url?: string; type?: string }> };
    try {
      parsed = JSON.parse(await readFile(file, "utf8"));
    } catch (err) {
      fail(`Cannot read ${file}: ${(err as Error).message}`);
    }
    const servers = parsed.mcpServers ?? {};
    if (Object.keys(servers).length === 0) fail(`No 'mcpServers' entries found in ${file}.`);

    const reg = await loadRegistry(registryPath);
    let added = 0;
    for (const [rawName, entry] of Object.entries(servers)) {
      const name = rawName.toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/^-+/, "").slice(0, 32);
      const cfg: PluginConfig = {
        transport: entry.url ? "http" : "stdio",
        command: entry.command,
        args: entry.args,
        env: entry.env,
        url: entry.url,
        enabled: true,
        addedAt: new Date().toISOString(),
      };
      try {
        staticValidate(name, cfg);
      } catch (err) {
        process.stdout.write(`Skipping '${rawName}': ${(err as Error).message}\n`);
        continue;
      }
      if (!opts.skipValidate) {
        process.stdout.write(`Validating '${name}'... `);
        const validation = await validatePlugin(name, cfg);
        cfg.validation = validation;
        if (!validation.ok) {
          process.stdout.write(`FAILED (${validation.error}) — skipped\n`);
          continue;
        }
        process.stdout.write(`OK (${validation.toolCount} tools)\n`);
      }
      reg.plugins[name] = cfg;
      audit.log("plugin.add", "cli", { plugin: name, ok: true, detail: { importedFrom: file } });
      added += 1;
    }
    await saveRegistry(registryPath, reg);
    process.stdout.write(`Imported ${added} plugin(s) into ${registryPath}.\n`);
  });

// ---------------------------------------------------------------- install claude

program
  .command("install")
  .description("Print or run the command that imports this gateway into a client (currently: claude)")
  .argument("<client>", "Target client, e.g. 'claude' for Claude Code")
  .option("--http", "Use the Streamable HTTP transport instead of stdio")
  .option("--port <port>", "HTTP port (with --http)", "3000")
  .option("--print", "Print the command instead of executing it")
  .action((client: string, opts) => {
    if (client !== "claude") fail(`Unsupported client '${client}'. Supported: claude`);
    const opts2 = program.opts<GlobalOpts>();
    const registryFlag = opts2.registry ? ` --registry ${opts2.registry}` : "";

    let command: string;
    if (opts.http) {
      const url = `http://127.0.0.1:${opts.port}/mcp`;
      process.stdout.write(
        `Step 1 — start the gateway (keep it running):\n\n` +
          `  ${selfInvocation()}${registryFlag} serve --http --port ${opts.port}\n\n` +
          `Step 2 — register it with Claude Code:\n\n` +
          `  claude mcp add --transport http mcp-controller ${url}\n\n`,
      );
      return;
    } else {
      command = `claude mcp add mcp-controller -- ${selfInvocation()}${registryFlag} serve`;
    }

    if (opts.print || !claudeOnPath()) {
      process.stdout.write(
        `Run this to import the gateway into Claude Code:\n\n  ${command}\n\n` +
          (claudeOnPath() ? "" : "(the 'claude' binary was not found on PATH, so the command is printed for copy-paste)\n"),
      );
      return;
    }
    process.stdout.write(`Running: ${command}\n`);
    const [bin, ...rest] = command.split(" ");
    execFileSync(bin, rest, { stdio: "inherit" });
  });

/** How to launch this same CLI: npx for npm installs, absolute node path for checkouts. */
function selfInvocation(): string {
  const self = fileURLToPath(import.meta.url);
  if (self.includes(`${path.sep}node_modules${path.sep}`)) {
    return "npx -y mcp-tools-controller";
  }
  return `node ${self}`;
}

function claudeOnPath(): boolean {
  const probe = process.platform === "win32" ? "where" : "which";
  return spawnSync(probe, ["claude"], { stdio: "ignore" }).status === 0;
}

// ---------------------------------------------------------------- logs

program
  .command("logs")
  .description("Show the most recent audit log entries (plugin lifecycle + tool calls)")
  .option("-n <count>", "Number of entries to show", "50")
  .action(async (opts) => {
    const { registryPath } = ctx();
    const auditPath = auditPathFor(registryPath);
    let raw: string;
    try {
      raw = await readFile(auditPath, "utf8");
    } catch {
      process.stdout.write(`No audit log yet at ${auditPath}.\n`);
      return;
    }
    const lines = raw.trim().split("\n");
    const count = Math.max(1, Number(opts.n) || 50);
    for (const line of lines.slice(-count)) {
      try {
        const e = JSON.parse(line);
        const status = e.ok === undefined ? "" : e.ok ? " ok" : " FAILED";
        const detail = e.detail ? ` ${JSON.stringify(e.detail)}` : "";
        process.stdout.write(`${e.ts}  ${e.event}${status}  actor=${e.actor}${e.plugin ? ` plugin=${e.plugin}` : ""}${detail}\n`);
      } catch {
        process.stdout.write(line + "\n");
      }
    }
  });

program.parseAsync(process.argv).catch((err) => {
  fail((err as Error).message);
});
