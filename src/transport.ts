import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { PluginConfig } from "./types.js";
import { log } from "./logger.js";

/**
 * Build a client transport for a plugin config.
 *
 * stdio child processes get `stderr: "pipe"` (the SDK default is "inherit")
 * so plugin noise is re-logged with a prefix instead of interleaving with the
 * gateway's own stderr.
 */
export function buildClientTransport(name: string, cfg: PluginConfig): Transport {
  if (cfg.transport === "http") {
    if (!cfg.url) throw new Error(`Plugin '${name}': http transport requires a url`);
    return new StreamableHTTPClientTransport(new URL(cfg.url), {
      requestInit: cfg.headers ? { headers: cfg.headers } : undefined,
    });
  }
  if (!cfg.command) throw new Error(`Plugin '${name}': stdio transport requires a command`);
  const transport = new StdioClientTransport({
    command: cfg.command,
    args: cfg.args ?? [],
    env: { ...getDefaultEnvironment(), ...(cfg.env ?? {}) },
    cwd: cfg.cwd,
    stderr: "pipe",
  });
  // transport.stderr is available after start(); Client.connect() starts the
  // transport, so defer attaching until the stream exists.
  queueMicrotask(() => {
    const stderr = transport.stderr;
    if (stderr) {
      stderr.on("data", (chunk: Buffer) => {
        for (const line of chunk.toString().split("\n")) {
          if (line.trim().length > 0) log.plugin(name, line);
        }
      });
    }
  });
  return transport;
}

/**
 * Minimal safe environment for child servers, mirroring the SDK's own
 * default-environment behavior: pass through PATH and HOME-ish variables only,
 * plus anything explicitly configured on the plugin.
 */
function getDefaultEnvironment(): Record<string, string> {
  const allowlist = [
    "PATH",
    "HOME",
    "USER",
    "SHELL",
    "TERM",
    "LANG",
    "LC_ALL",
    "TMPDIR",
    "TEMP",
    "TMP",
    "SYSTEMROOT",
    "SYSTEMDRIVE",
    "WINDIR",
    "USERPROFILE",
    "APPDATA",
    "LOCALAPPDATA",
    "PROGRAMFILES",
    "COMSPEC",
  ];
  const env: Record<string, string> = {};
  for (const key of allowlist) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  return env;
}
