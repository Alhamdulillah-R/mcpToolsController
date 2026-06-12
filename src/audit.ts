import { appendFile } from "node:fs/promises";
import type { Actor } from "./types.js";
import { log } from "./logger.js";

export interface AuditEvent {
  ts: string;
  event: string;
  actor: Actor;
  plugin?: string;
  ok?: boolean;
  detail?: Record<string, unknown>;
}

/**
 * Append-only JSONL audit log. Every plugin lifecycle change and every proxied
 * tool call is recorded so connections and usage are traceable.
 *
 * Logging is fire-and-forget and must never throw or block the gateway.
 */
export class AuditLogger {
  constructor(private readonly filePath: string) {}

  log(
    event: string,
    actor: Actor,
    fields: { plugin?: string; ok?: boolean; detail?: Record<string, unknown> } = {},
  ): void {
    const entry: AuditEvent = {
      ts: new Date().toISOString(),
      event,
      actor,
      ...fields,
    };
    appendFile(this.filePath, JSON.stringify(entry) + "\n").catch((err) => {
      log.warn(`audit write failed: ${String(err)}`);
    });
  }
}
