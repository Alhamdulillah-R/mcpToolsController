/**
 * Logger that writes exclusively to stderr.
 *
 * IMPORTANT: in stdio serve mode, stdout belongs to the MCP transport.
 * Any stray write to stdout corrupts JSON-RPC framing, so server code paths
 * must never use console.log. CLI commands that print results for humans
 * use process.stdout directly and only outside of serve mode.
 */
function write(level: string, message: string): void {
  process.stderr.write(`[mcpctl] ${level} ${message}\n`);
}

export const log = {
  info(message: string): void {
    write("INFO ", message);
  },
  warn(message: string): void {
    write("WARN ", message);
  },
  error(message: string): void {
    write("ERROR", message);
  },
  /** Re-log a downstream plugin's stderr line with a prefix. */
  plugin(pluginName: string, line: string): void {
    process.stderr.write(`[plugin:${pluginName}] ${line}\n`);
  },
};
