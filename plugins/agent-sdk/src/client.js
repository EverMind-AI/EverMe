/**
 * EverMe HTTP client for the plugin runtime.
 *
 * Design points:
 *  - Single Bearer header from cfg.agentToken (never logged, never folded
 *    into error messages — see redactError).
 *  - Backend response envelope is { error, requestId, status, result }.
 *    status === 0 → success, return result. Anything else → typed error.
 *  - Two upload-flow timeouts: regular requests use TIMEOUT_MS (30s),
 *    S3 multipart uploads use UPLOAD_TIMEOUT_MS (120s) — passed in by
 *    upload.js when needed.
 *  - One soft retry on transient transport failures. The caller (assemble
 *    / save / search) decides whether to surface the error or degrade.
 */

import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { TIMEOUT_MS } from "./config.js";
import { boundedTimeoutMs } from "./hooks/deadline.js";

const noop = { info() {}, warn() {} };

/**
 * Token regex — used by redactError to scrub a literal token if it
 * accidentally lands in an error message (defense-in-depth, the same
 * shape evercli's output.redact uses).
 */
// Token regex: case-insensitive on both alphabet AND prefix. Current
// issuance is lowercase hex but defense-in-depth covers a future
// alphabet change without us having to chase every log/error sink.
const evtRe = /evt_[a-zA-Z0-9]{32}/g;
const emkRe = /emk_[a-zA-Z0-9]{32}/g;

// AWS S3 presigned-POST / GET URLs carry short-lived but real
// credentials. The query-string fields below are issued for ~15 min
// each — long enough to be lifted from a log file and reused.
// Conservative scrub: replace the value of each known signing param
// with [REDACTED]. Keep the param name so the surrounding URL still
// looks like a URL (helps debugging without leaking secrets).
const s3SigParamRe = /(X-Amz-Signature|X-Amz-Security-Token|X-Amz-Credential|x-amz-signature|x-amz-security-token|x-amz-credential)=[^&"\s]+/g;

// MMS find responses sometimes embed bare AWS access key IDs (`ASIA…` /
// `AKIA…`). Scrub those defensively too.
const awsKeyIDRe = /A(?:SIA|KIA)[A-Z0-9]{16}/g;

/**
 * Redact secrets from a log/error message. Exported so callers outside
 * client.js (mcp.js errResp, engine.js warn paths, tool error replies)
 * can apply the same scrub before surfacing text to the host LLM or to
 * persistent stderr.
 *
 * Currently scrubs: evt_ / emk_ tokens, S3 signing query params, AWS
 * access key IDs. Adding new patterns here is the right way to expand —
 * never replicate the regex elsewhere.
 */
export function redactError(msg) {
  if (msg == null) return "";
  // For Error objects, prefer .message; fall back to String() for
  // plain strings / primitives. Avoid serializing the whole stack —
  // that often contains URLs and headers that we'd then have to
  // also scrub.
  const text = msg instanceof Error ? msg.message : String(msg);
  return text
    .replace(evtRe, (m) => m.slice(0, 8) + "_REDACTED")
    .replace(emkRe, (m) => m.slice(0, 8) + "_REDACTED")
    .replace(s3SigParamRe, (_, name) => name + "=[REDACTED]")
    .replace(awsKeyIDRe, "[REDACTED-AWSKEY]");
}

/**
 * Typed error returned from request(). `code` is the backend errno when
 * the failure came through the envelope; otherwise 0. `requestId` is
 * surfaced from the envelope's requestId field for support correlation.
 */
export class EvermeError extends Error {
  constructor({ message, status = 0, code = 0, requestId = "", type = "upstream" }) {
    super(redactError(message));
    this.name = "EvermeError";
    this.httpStatus = status;
    this.code = code;
    this.requestId = requestId;
    this.type = type;
  }

  /**
   * Support-friendly one-liner: message plus the errno and requestId a user
   * can quote to correlate with server-side logs. Every user-facing error
   * sink (MCP errResp, hook diagnostics, engine warns) should prefer this
   * over .message.
   */
  describe() {
    const parts = [];
    if (this.code) parts.push(`errno=${this.code}`);
    if (this.requestId) parts.push(`requestId=${this.requestId}`);
    return parts.length ? `${this.message} (${parts.join(", ")})` : this.message;
  }
}

/**
 * Render any error for user-facing sinks: EvermeError gets its describe()
 * form (errno + requestId), everything else falls back to redactError.
 */
export function describeError(err) {
  if (err instanceof EvermeError) return err.describe();
  return redactError(err?.message || String(err));
}

/**
 * Meta-aware call helper for SDK wrappers. Real clients expose
 * requestWithMeta; test stubs and host-provided fakes may only implement
 * request — fall back gracefully with an empty requestId.
 */
export async function requestMeta(client, method, path, body, opts) {
  if (typeof client?.requestWithMeta === "function") {
    return client.requestWithMeta(method, path, body, opts);
  }
  return { result: await client.request(method, path, body, opts), requestId: "" };
}

/**
 * Build a Client closure. We don't use a class so testing can stub
 * individual methods (e.g. inject a fake fetch via cfg).
 */
export function createClient(cfg, log = noop) {
  const headers = (requestId) => ({
    "Content-Type": "application/json",
    Accept: "application/json",
    Authorization: `Bearer ${cfg.agentToken}`,
    "User-Agent": `everme-memory-mcp/0.1 (agentId=${cfg.agentId})`,
    // Client-generated trace id. The gateway reuses a valid inbound value,
    // so plugin logs, EverMe ELK, and the cloud platform all join on it —
    // even when the request times out before any response arrives.
    requestId,
  });

  /**
   * Single-funnel request helper. Path is appended to cfg.baseUrl.
   * `body` may be undefined for GET. Resolves to { result, requestId } or
   * throws an EvermeError (which carries the same requestId).
   */
  async function requestWithMeta(method, path, body, { timeoutMs = TIMEOUT_MS, query } = {}) {
    const requestId = randomUUID();
    const url = buildUrl(cfg.baseUrl, path, query);
    const init = {
      method,
      headers: headers(requestId),
      body: body == null ? undefined : JSON.stringify(body),
    };
    // cfg.deadlineAt is set when the caller runs under a host deadline (a
    // native hook). Clamping here is what makes sequential requests share
    // one budget instead of each taking a fresh timeoutMs.
    return execWithRetry(url, init, boundedTimeoutMs(timeoutMs, cfg.deadlineAt), log, requestId);
  }

  /**
   * Back-compat helper: same as requestWithMeta but resolves to the bare
   * envelope result. Callers that need the trace id use requestWithMeta.
   */
  async function request(method, path, body, opts) {
    const { result } = await requestWithMeta(method, path, body, opts);
    return result;
  }

  /**
   * Raw S3 / external POST — doesn't carry the everme Bearer header. Used
   * by upload.js to send the multipart body to the presigned S3 URL.
   *
   * When `contentType` is omitted and `body` is a FormData, we let fetch
   * derive the `multipart/form-data; boundary=…` header itself. Passing
   * an explicit Content-Type would clobber the boundary and S3 would
   * reject the upload as malformed.
   */
  async function rawPost(uploadUrl, body, contentType, { timeoutMs = TIMEOUT_MS } = {}) {
    timeoutMs = boundedTimeoutMs(timeoutMs, cfg.deadlineAt);
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), timeoutMs);
    try {
      const headers = contentType ? { "Content-Type": contentType } : undefined;
      let res;
      try {
        res = await fetch(uploadUrl, {
          method: "POST",
          body,
          headers,
          signal: ac.signal,
        });
      } catch (err) {
        // Native fetch errors (AbortError on timeout, ECONNRESET, etc.)
        // can stringify with the full URL — and the URL carries the
        // S3 signature query params. Wrap in EvermeError + redact so
        // nothing past this catch ever sees the secret.
        const aborted = ac.signal?.aborted;
        throw new EvermeError({
          message: redactError(
            aborted
              ? `S3 upload aborted after ${timeoutMs}ms`
              : `S3 upload transport error: ${err?.message || String(err)}`,
          ),
          type: aborted ? "timeout" : "upstream",
        });
      }
      // Body read inherits the same AbortController as the fetch.
      // Without this, headers could arrive within timeout, body could
      // hang past timeout, .catch(()=>"") would swallow the abort
      // error, and the 2xx branch below would falsely report success
      // for an upload whose body never finished.
      let text = "";
      let bodyReadFailed = false;
      try {
        text = await res.text();
      } catch (err) {
        bodyReadFailed = true;
        if (ac.signal?.aborted) {
          throw new EvermeError({
            message: redactError(`S3 upload aborted reading body after ${timeoutMs}ms`),
            type: "timeout",
          });
        }
        // Non-abort body-read failure (network truncation post-headers).
        // Treat as upstream — we can't trust the 2xx without the body
        // having drained, since multipart/form-data parts may have been
        // truncated mid-stream.
        throw new EvermeError({
          message: redactError(`S3 upload body read failed: ${err?.message || String(err)}`),
          type: "upstream",
        });
      }
      if (!bodyReadFailed && res.status >= 200 && res.status < 300) return { ok: true };
      // Body text from S3 sometimes echoes bucket name + key, which is
      // OK to surface, but redact defensively in case S3 ever decides
      // to reflect a header containing a sig.
      throw new EvermeError({
        message: redactError(
          `S3 upload rejected: HTTP ${res.status}${text ? " — " + text.slice(0, 200) : ""}`,
        ),
        status: res.status,
        type: "upstream",
      });
    } finally {
      clearTimeout(t);
    }
  }

  return { request, requestWithMeta, rawPost };
}

function buildUrl(base, path, query) {
  const qs = query ? new URLSearchParams() : null;
  if (qs) {
    for (const [k, v] of Object.entries(query)) {
      if (v == null || v === "") continue;
      if (Array.isArray(v)) v.forEach((x) => qs.append(k, String(x)));
      else qs.set(k, String(v));
    }
  }
  const q = qs?.toString();
  return q ? `${base}${path}?${q}` : `${base}${path}`;
}

async function execWithRetry(url, init, timeoutMs, log, requestId) {
  try {
    return await execOnce(url, init, timeoutMs, requestId);
  } catch (err) {
    if (err instanceof EvermeError) {
      // Application-level errors don't get retried — only transport.
      throw err;
    }
    // Only GET is safe to retry on a transport error. POST /mem/agent-memory
    // and other writes can succeed server-side after the response is lost
    // mid-flight; retrying duplicates the write. Idempotency keys would let
    // us retry safely, but the current backend contract doesn't accept one
    // on every write path, so we err on the side of surfacing the error.
    const method = (init?.method || "GET").toUpperCase();
    if (method !== "GET" && method !== "HEAD") {
      throw err;
    }
    log.warn?.(`[everme] ${method} failed, retrying once (requestId=${requestId}): ${redactError(err?.message)}`);
    await sleep(150);
    return execOnce(url, init, timeoutMs, requestId);
  }
}

async function execOnce(url, init, timeoutMs, requestId = "") {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  let res;
  let text = "";
  try {
    try {
      res = await fetch(url, { ...init, signal: ac.signal });
    } catch (err) {
      // Throw EvermeError (not plain Error) so execWithRetry's
      // `instanceof EvermeError` short-circuit fires for timeouts —
      // previously a timeout was caught as a transport error and
      // retried, doubling the user-visible wait AND losing the
      // type:"timeout" semantic that callers (assemble degrade,
      // dispose) rely on.
      const aborted = ac.signal.aborted;
      throw new EvermeError({
        message: aborted
          ? `timed out after ${timeoutMs}ms`
          : redactError(err?.message || String(err)),
        requestId,
        type: aborted ? "timeout" : "upstream",
      });
    }
    // Body read inherits the same AbortController so a stuck body still
    // trips the timeout. Without this, headers could arrive in time but
    // the body hangs past timeout; `.catch(()=>"")` would swallow the
    // abort and the empty-text path below would parse `{}` and return
    // `null` as if the call had succeeded.
    try {
      text = await res.text();
    } catch (err) {
      const aborted = ac.signal.aborted;
      throw new EvermeError({
        message: aborted
          ? `timed out reading body after ${timeoutMs}ms`
          : redactError(`body read failed: ${err?.message || String(err)}`),
        requestId,
        type: aborted ? "timeout" : "upstream",
      });
    }
  } finally {
    clearTimeout(t);
  }

  let env;
  try {
    env = text ? JSON.parse(text) : {};
  } catch {
    // Non-JSON response (load shedder, proxy 502 page, etc). The gateway
    // echoes the id on the response header even when a proxy mangles the
    // body, so prefer that before falling back to our own id.
    throw new EvermeError({
      message: `HTTP ${res.status}${text ? " — " + text.slice(0, 200) : ""}`,
      status: res.status,
      requestId: res.headers?.get?.("requestId") || requestId,
      type: res.status === 401 || res.status === 403 ? "auth" : "upstream",
    });
  }

  if (env && env.status === 0) {
    return { result: env.result ?? null, requestId: env.requestId || requestId };
  }
  // Envelope-encoded failure or missing status.
  const code = Number(env?.status) || 0;
  const errType = code >= 30000 && code < 30300 && code !== 30104 ? "auth" : "upstream";
  throw new EvermeError({
    message: env?.error || `HTTP ${res.status}`,
    status: res.status,
    code,
    requestId: env?.requestId || requestId,
    type: errType,
  });
}
