/**
 * Delivery status a host plugin leaves on disk for the desktop self-check:
 * one file per host and outcome under <memory home>/delivery/, holding only
 * the latest occurrence. No session content is written.
 */

import { createHash } from "node:crypto";
import { mkdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { EvermeError } from "./client.js";

// Never throws: a status file that cannot be written must not cost the upload.
export function recordDelivery(host, kind, { reason = null, pluginVersion = "", agentId = "" } = {}, log = { warn() {} }) {
  // Same directory rule as readDeviceRoute; the desktop helper resolves it
  // the same way.
  const dir = join(process.env.EVERME_MEMORY_HOME || join(homedir(), ".everme", "memory"), "delivery");
  const file = join(dir, `${host}.${kind}.json`);
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(temp, JSON.stringify({
      schema: 1,
      at: new Date().toISOString(),
      reason,
      plugin_version: pluginVersion,
      agent_ref: deliveryAgentRef(agentId),
    }), { encoding: "utf8", mode: 0o600 });
    renameSync(temp, file);
  } catch (error) {
    try {
      unlinkSync(temp);
    } catch {}
    log.warn?.(`[everme] delivery status not recorded host=${host} kind=${kind} code=${error?.code || "unknown"}`);
  }
}

// The gateway computes the same value from agent.uid to tell accounts apart.
export function deliveryAgentRef(agentId) {
  return createHash("sha256").update(String(agentId ?? ""), "utf8").digest("hex").slice(0, 16);
}

// Closed set; the first matching row wins.
export function deliveryFailReason(error) {
  const err = error instanceof EvermeError ? error : error?.cause;
  if (!(err instanceof EvermeError)) return "other";
  if (err.type === "auth") return "auth";
  if (err.type === "timeout") return "timeout";
  if (err.httpStatus >= 400 && err.httpStatus <= 499) return "http_4xx";
  if (err.httpStatus >= 500) return "http_5xx";
  if (err.httpStatus === 0) return "network";
  return "other";
}
