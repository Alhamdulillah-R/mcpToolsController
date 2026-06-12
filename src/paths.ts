import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

export const REGISTRY_FILENAME = "plugins.json";
export const AUDIT_FILENAME = "audit.log";
export const CONFIG_DIRNAME = ".mcp-controller";

/**
 * Resolve the registry file path. Precedence:
 *   1. explicit --registry flag
 *   2. $MCP_CONTROLLER_HOME/plugins.json
 *   3. ./.mcp-controller/plugins.json (project-local, only if it already exists)
 *   4. ~/.mcp-controller/plugins.json (default; directory auto-created)
 */
export function resolveRegistryPath(explicit?: string): string {
  if (explicit) {
    mkdirSync(path.dirname(path.resolve(explicit)), { recursive: true });
    return path.resolve(explicit);
  }
  const envHome = process.env.MCP_CONTROLLER_HOME;
  if (envHome) {
    mkdirSync(envHome, { recursive: true });
    return path.join(envHome, REGISTRY_FILENAME);
  }
  const local = path.join(process.cwd(), CONFIG_DIRNAME, REGISTRY_FILENAME);
  if (existsSync(local)) {
    return local;
  }
  const globalDir = path.join(homedir(), CONFIG_DIRNAME);
  mkdirSync(globalDir, { recursive: true });
  return path.join(globalDir, REGISTRY_FILENAME);
}

/** The audit log always lives next to the registry file. */
export function auditPathFor(registryPath: string): string {
  return path.join(path.dirname(registryPath), AUDIT_FILENAME);
}
