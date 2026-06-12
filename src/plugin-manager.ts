import { EventEmitter } from "node:events";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  ToolListChangedNotificationSchema,
  type CallToolResult,
} from "@modelcontextprotocol/sdk/types.js";
import type { AuditLogger } from "./audit.js";
import { log } from "./logger.js";
import {
  loadRegistry,
  saveRegistry,
  watchRegistry,
  type RegistryWatcher,
} from "./registry.js";
import { buildClientTransport } from "./transport.js";
import { staticValidate, validatePlugin } from "./validator.js";
import {
  NAMESPACE_SEPARATOR,
  type Actor,
  type NamespacedTool,
  type PluginConfig,
  type PluginState,
  type PluginStatus,
  type RegistryFile,
  type ValidationRecord,
} from "./types.js";

const RECONNECT_BACKOFF_MS = [1_000, 2_000, 5_000, 15_000, 30_000];

interface PluginConnection {
  config: PluginConfig;
  client?: Client;
  state: PluginState;
  tools: NamespacedTool[];
  lastError?: string;
  reconnectTimer?: NodeJS.Timeout;
  backoffIndex: number;
  /** Set while we are closing the connection on purpose (remove/disable). */
  closing: boolean;
}

/**
 * Owns the lifecycle of all plugin connections and is the heart of hot reload:
 * the registry file is the single source of truth, and applyRegistry() diffs
 * the desired state against live connections — connecting, disconnecting, or
 * reconnecting as needed — then emits "tools-changed" so gateway servers can
 * broadcast notifications/tools/list_changed to connected clients.
 */
export class PluginManager extends EventEmitter {
  private readonly connections = new Map<string, PluginConnection>();
  private watcher?: RegistryWatcher;
  private toolsChangedScheduled = false;
  private stopped = false;

  constructor(
    private readonly registryPath: string,
    private readonly audit: AuditLogger,
  ) {
    super();
  }

  async start(): Promise<void> {
    const reg = await loadRegistry(this.registryPath);
    await this.applyRegistry(reg);
    this.watcher = watchRegistry(this.registryPath, (updated) => {
      log.info("registry changed on disk; applying hot reload");
      void this.applyRegistry(updated).catch((err) =>
        log.error(`hot reload failed: ${String(err)}`),
      );
    });
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.watcher?.close();
    await Promise.all(
      [...this.connections.keys()].map((name) => this.disconnect(name)),
    );
    this.connections.clear();
  }

  /** Diff desired registry state against live connections. */
  async applyRegistry(reg: RegistryFile): Promise<void> {
    const desired = reg.plugins;
    const work: Promise<void>[] = [];

    // Removed plugins
    for (const name of this.connections.keys()) {
      if (!(name in desired)) {
        work.push(this.dropPlugin(name));
      }
    }

    for (const [name, cfg] of Object.entries(desired)) {
      const existing = this.connections.get(name);
      if (!existing) {
        this.connections.set(name, {
          config: cfg,
          state: cfg.enabled ? "connecting" : "disabled",
          tools: [],
          backoffIndex: 0,
          closing: false,
        });
        if (cfg.enabled) work.push(this.connect(name));
        continue;
      }
      const configChanged = !sameConnectionConfig(existing.config, cfg);
      const enabledChanged = existing.config.enabled !== cfg.enabled;
      existing.config = cfg;
      if (!cfg.enabled && (enabledChanged || existing.state !== "disabled")) {
        work.push(
          this.disconnect(name).then(() => {
            const conn = this.connections.get(name);
            if (conn) conn.state = "disabled";
            this.scheduleToolsChanged();
          }),
        );
      } else if (cfg.enabled && (configChanged || enabledChanged || existing.state === "disabled")) {
        work.push(this.reconnect(name));
      }
    }

    await Promise.all(work);
  }

  getTools(): NamespacedTool[] {
    const tools: NamespacedTool[] = [];
    for (const conn of this.connections.values()) {
      if (conn.state === "ready") tools.push(...conn.tools);
    }
    return tools;
  }

  getStatus(): PluginStatus[] {
    return [...this.connections.entries()].map(([name, conn]) => ({
      name,
      state: conn.state,
      transport: conn.config.transport,
      enabled: conn.config.enabled,
      toolCount: conn.tools.length,
      tools: conn.tools.map((t) => t.originalName),
      error: conn.lastError,
      validation: conn.config.validation,
    }));
  }

  async callTool(namespacedName: string, args: Record<string, unknown>): Promise<CallToolResult> {
    const sep = namespacedName.indexOf(NAMESPACE_SEPARATOR);
    if (sep <= 0) {
      return errorResult(
        `Unknown tool '${namespacedName}'. Aggregated tools are named '<plugin>${NAMESPACE_SEPARATOR}<tool>'.`,
      );
    }
    const pluginName = namespacedName.slice(0, sep);
    const toolName = namespacedName.slice(sep + NAMESPACE_SEPARATOR.length);
    const conn = this.connections.get(pluginName);
    if (!conn) {
      return errorResult(`Unknown plugin '${pluginName}'. Call plugin_list to see available plugins.`);
    }
    if (conn.state !== "ready" || !conn.client) {
      return errorResult(
        `Plugin '${pluginName}' is not available (state: ${conn.state}` +
          (conn.lastError ? `, last error: ${conn.lastError}` : "") +
          `). Try plugin_reload with name '${pluginName}'.`,
      );
    }
    const startedAt = Date.now();
    try {
      const result = (await conn.client.callTool({
        name: toolName,
        arguments: args,
      })) as CallToolResult;
      this.audit.log("tool.call", "gateway", {
        plugin: pluginName,
        ok: result.isError !== true,
        detail: { tool: toolName, durationMs: Date.now() - startedAt },
      });
      return result;
    } catch (err) {
      this.audit.log("tool.call", "gateway", {
        plugin: pluginName,
        ok: false,
        detail: { tool: toolName, durationMs: Date.now() - startedAt, error: String(err) },
      });
      return errorResult(`Call to '${namespacedName}' failed: ${(err as Error).message}`);
    }
  }

  // --- direct mutators (used by the CLI-over-registry flow and MCP management tools) ---

  /** Validate, persist, and connect a new plugin. Returns the validation record. */
  async addPlugin(
    name: string,
    cfg: PluginConfig,
    actor: Actor,
    opts: { skipValidate?: boolean; force?: boolean } = {},
  ): Promise<ValidationRecord> {
    staticValidate(name, cfg);
    const reg = await loadRegistry(this.registryPath);
    if (reg.plugins[name] && !opts.force) {
      throw new Error(`Plugin '${name}' already exists. Use force to overwrite.`);
    }
    let validation: ValidationRecord;
    if (opts.skipValidate) {
      validation = {
        ok: false,
        validatedAt: new Date().toISOString(),
        error: "validation skipped",
      };
    } else {
      validation = await validatePlugin(name, cfg);
      if (!validation.ok) {
        this.audit.log("plugin.add", actor, {
          plugin: name,
          ok: false,
          detail: { error: validation.error },
        });
        throw new Error(`Validation failed for '${name}': ${validation.error}`);
      }
    }
    cfg.validation = validation;
    reg.plugins[name] = cfg;
    await this.persist(reg);
    this.audit.log("plugin.add", actor, {
      plugin: name,
      ok: true,
      detail: { transport: cfg.transport, command: cfg.command, url: cfg.url },
    });
    await this.applyRegistry(reg);
    return validation;
  }

  async removePlugin(name: string, actor: Actor): Promise<void> {
    const reg = await loadRegistry(this.registryPath);
    if (!reg.plugins[name]) throw new Error(`Plugin '${name}' is not registered.`);
    delete reg.plugins[name];
    await this.persist(reg);
    this.audit.log("plugin.remove", actor, { plugin: name, ok: true });
    await this.applyRegistry(reg);
  }

  async setEnabled(name: string, enabled: boolean, actor: Actor): Promise<void> {
    const reg = await loadRegistry(this.registryPath);
    const cfg = reg.plugins[name];
    if (!cfg) throw new Error(`Plugin '${name}' is not registered.`);
    cfg.enabled = enabled;
    await this.persist(reg);
    this.audit.log(enabled ? "plugin.enable" : "plugin.disable", actor, {
      plugin: name,
      ok: true,
    });
    await this.applyRegistry(reg);
  }

  /** Reconnect one plugin, or re-read the registry and reconcile everything. */
  async reloadPlugin(name: string | undefined, actor: Actor): Promise<void> {
    this.audit.log("plugin.reload", actor, { plugin: name, ok: true });
    if (name) {
      if (!this.connections.has(name)) throw new Error(`Plugin '${name}' is not registered.`);
      await this.reconnect(name);
      return;
    }
    const reg = await loadRegistry(this.registryPath);
    await this.applyRegistry(reg);
    await Promise.all(
      [...this.connections.entries()]
        .filter(([, conn]) => conn.config.enabled)
        .map(([n]) => this.reconnect(n)),
    );
  }

  async revalidatePlugin(name: string, actor: Actor): Promise<ValidationRecord> {
    const reg = await loadRegistry(this.registryPath);
    const cfg = reg.plugins[name];
    if (!cfg) throw new Error(`Plugin '${name}' is not registered.`);
    const validation = await validatePlugin(name, cfg);
    cfg.validation = validation;
    await this.persist(reg);
    const conn = this.connections.get(name);
    if (conn) conn.config.validation = validation;
    this.audit.log("plugin.validate", actor, {
      plugin: name,
      ok: validation.ok,
      detail: validation.ok ? { toolCount: validation.toolCount } : { error: validation.error },
    });
    return validation;
  }

  // --- internals ---

  private async persist(reg: RegistryFile): Promise<void> {
    const hash = await saveRegistry(this.registryPath, reg);
    this.watcher?.markSelfWrite(hash);
  }

  private async connect(name: string): Promise<void> {
    const conn = this.connections.get(name);
    if (!conn || this.stopped) return;
    conn.state = "connecting";
    conn.closing = false;

    const client = new Client({ name: "mcp-tools-controller", version: "0.1.0" });
    try {
      const transport = buildClientTransport(name, conn.config);
      await client.connect(transport);
      conn.client = client;

      client.onclose = () => {
        if (conn.closing || this.stopped) return;
        this.markFailed(name, "connection closed unexpectedly");
        this.scheduleReconnect(name);
      };
      client.onerror = (err) => {
        log.warn(`plugin '${name}' transport error: ${String(err)}`);
      };
      // Propagate downstream hot updates: if the plugin changes its own tool
      // list at runtime, re-fetch and notify upward.
      client.setNotificationHandler(ToolListChangedNotificationSchema, () => {
        void this.refreshTools(name);
      });

      conn.tools = await this.fetchTools(name, client);
      conn.state = "ready";
      conn.lastError = undefined;
      conn.backoffIndex = 0;
      this.audit.log("plugin.connect", "gateway", {
        plugin: name,
        ok: true,
        detail: { toolCount: conn.tools.length },
      });
      log.info(`plugin '${name}' connected (${conn.tools.length} tools)`);
      this.scheduleToolsChanged();
    } catch (err) {
      await client.close().catch(() => {});
      this.markFailed(name, (err as Error).message);
      this.scheduleReconnect(name);
    }
  }

  private async fetchTools(name: string, client: Client): Promise<NamespacedTool[]> {
    const tools: NamespacedTool[] = [];
    let cursor: string | undefined;
    do {
      const page = await client.listTools(cursor ? { cursor } : {});
      for (const tool of page.tools) {
        tools.push({
          name: `${name}${NAMESPACE_SEPARATOR}${tool.name}`,
          pluginName: name,
          originalName: tool.name,
          description: tool.description,
          inputSchema: tool.inputSchema as Record<string, unknown>,
          outputSchema: tool.outputSchema as Record<string, unknown> | undefined,
          annotations: tool.annotations as Record<string, unknown> | undefined,
        });
      }
      cursor = page.nextCursor;
    } while (cursor);
    return tools;
  }

  private async refreshTools(name: string): Promise<void> {
    const conn = this.connections.get(name);
    if (!conn?.client || conn.state !== "ready") return;
    try {
      conn.tools = await this.fetchTools(name, conn.client);
      log.info(`plugin '${name}' updated its tool list (${conn.tools.length} tools)`);
      this.scheduleToolsChanged();
    } catch (err) {
      log.warn(`failed to refresh tools for '${name}': ${String(err)}`);
    }
  }

  private markFailed(name: string, error: string): void {
    const conn = this.connections.get(name);
    if (!conn) return;
    const hadTools = conn.tools.length > 0;
    conn.state = "error";
    conn.lastError = error;
    conn.tools = [];
    conn.client = undefined;
    this.audit.log("plugin.error", "gateway", { plugin: name, ok: false, detail: { error } });
    log.warn(`plugin '${name}' unavailable: ${error}`);
    if (hadTools) this.scheduleToolsChanged();
  }

  private scheduleReconnect(name: string): void {
    const conn = this.connections.get(name);
    if (!conn || this.stopped || !conn.config.enabled) return;
    const delay =
      RECONNECT_BACKOFF_MS[Math.min(conn.backoffIndex, RECONNECT_BACKOFF_MS.length - 1)];
    conn.backoffIndex += 1;
    if (conn.reconnectTimer) clearTimeout(conn.reconnectTimer);
    conn.reconnectTimer = setTimeout(() => {
      conn.reconnectTimer = undefined;
      if (this.connections.get(name)?.config.enabled) void this.connect(name);
    }, delay);
    conn.reconnectTimer.unref?.();
    log.info(`plugin '${name}': retrying in ${delay}ms`);
  }

  private async disconnect(name: string): Promise<void> {
    const conn = this.connections.get(name);
    if (!conn) return;
    conn.closing = true;
    if (conn.reconnectTimer) {
      clearTimeout(conn.reconnectTimer);
      conn.reconnectTimer = undefined;
    }
    const hadTools = conn.tools.length > 0;
    conn.tools = [];
    if (conn.client) {
      await conn.client.close().catch(() => {});
      conn.client = undefined;
      this.audit.log("plugin.disconnect", "gateway", { plugin: name, ok: true });
    }
    if (hadTools) this.scheduleToolsChanged();
  }

  private async dropPlugin(name: string): Promise<void> {
    await this.disconnect(name);
    this.connections.delete(name);
    log.info(`plugin '${name}' removed`);
    this.scheduleToolsChanged();
  }

  private async reconnect(name: string): Promise<void> {
    await this.disconnect(name);
    const conn = this.connections.get(name);
    if (conn) conn.backoffIndex = 0;
    await this.connect(name);
  }

  /** Coalesce multiple changes in the same tick into one event. */
  private scheduleToolsChanged(): void {
    if (this.toolsChangedScheduled) return;
    this.toolsChangedScheduled = true;
    setImmediate(() => {
      this.toolsChangedScheduled = false;
      this.emit("tools-changed");
    });
  }
}

function sameConnectionConfig(a: PluginConfig, b: PluginConfig): boolean {
  return (
    a.transport === b.transport &&
    a.command === b.command &&
    JSON.stringify(a.args ?? []) === JSON.stringify(b.args ?? []) &&
    JSON.stringify(a.env ?? {}) === JSON.stringify(b.env ?? {}) &&
    a.cwd === b.cwd &&
    a.url === b.url &&
    JSON.stringify(a.headers ?? {}) === JSON.stringify(b.headers ?? {})
  );
}

function errorResult(text: string): CallToolResult {
  return { isError: true, content: [{ type: "text", text }] };
}
