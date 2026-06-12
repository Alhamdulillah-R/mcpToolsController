import { createHash } from "node:crypto";
import { watch, type FSWatcher } from "node:fs";
import { readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { RegistryFile } from "./types.js";
import { log } from "./logger.js";

const EMPTY_REGISTRY: RegistryFile = { version: 1, plugins: {} };

export function serializeRegistry(reg: RegistryFile): string {
  return JSON.stringify(reg, null, 2) + "\n";
}

export function hashRegistry(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

/** A missing file is treated as an empty registry. */
export async function loadRegistry(filePath: string): Promise<RegistryFile> {
  let raw: string;
  try {
    raw = await readFile(filePath, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return structuredClone(EMPTY_REGISTRY);
    }
    throw err;
  }
  const parsed = JSON.parse(raw) as RegistryFile;
  if (parsed.version !== 1 || typeof parsed.plugins !== "object" || parsed.plugins === null) {
    throw new Error(`Invalid registry file at ${filePath}: expected {version: 1, plugins: {...}}`);
  }
  return parsed;
}

/**
 * Atomic save: write a temp file in the same directory, then rename over the
 * target. Readers (including the gateway's watcher) never see a partial file.
 */
export async function saveRegistry(filePath: string, reg: RegistryFile): Promise<string> {
  const content = serializeRegistry(reg);
  const tmpPath = filePath + ".tmp";
  await writeFile(tmpPath, content, "utf8");
  await rename(tmpPath, filePath);
  return hashRegistry(content);
}

export interface RegistryWatcher {
  close(): void;
  /** Record a hash of content this process just wrote, so the watcher skips it. */
  markSelfWrite(hash: string): void;
}

/**
 * Watch the registry for external changes (e.g. the CLI editing it while the
 * gateway is running).
 *
 * Watches the *directory*, not the file: atomic rename replaces the inode and
 * would silently kill a per-file watcher. Events are debounced (rename emits
 * doubles), and content identical to our own last write is ignored to avoid
 * reconnect loops when the gateway's management tools save the registry.
 */
export function watchRegistry(
  filePath: string,
  onChange: (reg: RegistryFile) => void,
  debounceMs = 300,
): RegistryWatcher {
  const dir = path.dirname(filePath);
  const filename = path.basename(filePath);
  const selfWrites = new Set<string>();
  let timer: NodeJS.Timeout | undefined;
  let closed = false;

  const reload = async (attempt = 0): Promise<void> => {
    if (closed) return;
    let raw: string;
    try {
      raw = await readFile(filePath, "utf8");
    } catch {
      // Mid-rename window or deleted file; retry once, then skip the event.
      if (attempt === 0) setTimeout(() => void reload(1), 100);
      return;
    }
    let reg: RegistryFile;
    try {
      reg = JSON.parse(raw) as RegistryFile;
    } catch {
      if (attempt === 0) setTimeout(() => void reload(1), 100);
      else log.warn(`registry at ${filePath} contains invalid JSON; change ignored`);
      return;
    }
    const hash = hashRegistry(raw);
    if (selfWrites.has(hash)) {
      selfWrites.delete(hash);
      return;
    }
    onChange(reg);
  };

  const watcher: FSWatcher = watch(dir, (_eventType, changed) => {
    if (changed !== filename) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => void reload(), debounceMs);
  });

  return {
    close(): void {
      closed = true;
      if (timer) clearTimeout(timer);
      watcher.close();
    },
    markSelfWrite(hash: string): void {
      selfWrites.add(hash);
      // Bound the set in case a watch event never fires for a write.
      if (selfWrites.size > 16) {
        const first = selfWrites.values().next().value;
        if (first !== undefined) selfWrites.delete(first);
      }
    },
  };
}
