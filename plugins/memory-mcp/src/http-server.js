import { createHash } from "node:crypto";
import http from "node:http";

import { createClient, redactError, resolveConfig } from "@everme/agent-sdk";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

import { createMcpServer } from "./mcp.js";

const EVT_TOKEN_RE = /^evt_[A-Za-z0-9]{32}$/;
const DEFAULT_RATE_LIMIT_MAX_KEYS = 10_000;
const DEFAULT_TOKEN_VALIDATION_MAX_PENDING = 100;
const noopLogger = { info() {}, warn() {} };
const defaultTransportFactory = (options) => new StreamableHTTPServerTransport(options);
const defaultSseTransportFactory = (endpoint, response) => new SSEServerTransport(endpoint, response);

export function createMcpHttpServer({
  apiBase = process.env.EVERME_API_BASE,
  logger = noopLogger,
  maxBodyBytes = readPositiveInt(process.env.MCP_HTTP_MAX_BODY_BYTES, 1024 * 1024),
  rateLimit = readPositiveInt(process.env.MCP_HTTP_RATE_LIMIT, 60),
  rateWindowMs = readPositiveInt(process.env.MCP_HTTP_RATE_WINDOW_MS, 60_000),
  rateLimitMaxKeys = DEFAULT_RATE_LIMIT_MAX_KEYS,
  tokenValidationMaxPending = readPositiveInt(
    process.env.MCP_HTTP_TOKEN_VALIDATION_MAX_PENDING,
    DEFAULT_TOKEN_VALIDATION_MAX_PENDING,
  ),
  now = Date.now,
  mcpServerFactory = createMcpServer,
  transportFactory = defaultTransportFactory,
  sseTransportFactory = defaultSseTransportFactory,
  tokenValidator = validateAgentToken,
} = {}) {
  const log = safeLogger(logger);
  const sseSessions = new Map();
  const limiter = createFixedWindowLimiter({
    rateLimit,
    rateWindowMs,
    maxKeys: readPositiveInt(rateLimitMaxKeys, DEFAULT_RATE_LIMIT_MAX_KEYS),
    maxPendingValidations: readPositiveInt(
      tokenValidationMaxPending,
      DEFAULT_TOKEN_VALIDATION_MAX_PENDING,
    ),
    now,
    validate: (agentToken) => tokenValidator(agentToken, { apiBase, log }),
  });

  const httpServer = http.createServer(async (req, res) => {
    const url = new URL(req.url || "/", "http://localhost");
    const route = routeRequest(url.pathname, req.method);
    if (route === "health") {
      sendJson(res, 200, { status: "ok" });
      return;
    }
    if (route === "not-found") {
      sendJsonRpcError(res, 404, -32000, "Not found");
      return;
    }
    if (route === "method-not-allowed") {
      res.setHeader("Allow", allowedMethods(url.pathname));
      sendJsonRpcError(res, 405, -32000, "Method not allowed");
      return;
    }

    const agentToken = await authenticateRequest(req, res, { limiter, log });
    if (!agentToken) return;

    try {
      if (route === "sse-open") {
        await openSseSession({
          res,
          agentToken,
          apiBase,
          log,
          sessions: sseSessions,
          mcpServerFactory,
          sseTransportFactory,
        });
        return;
      }

      const parsedBody = await readJsonBody(req, maxBodyBytes);
      if (route === "sse-message") {
        await handleSseMessage({
          req,
          res,
          parsedBody,
          agentToken,
          sessionId: url.searchParams.get("sessionId") || "",
          sessions: sseSessions,
        });
        return;
      }

      await handleMcpRequest({
        req,
        res,
        parsedBody,
        agentToken,
        apiBase,
        log,
        mcpServerFactory,
        transportFactory,
      });
    } catch (err) {
      if (err instanceof RequestBodyError) {
        sendJsonRpcError(res, err.status, err.code, err.message);
        return;
      }
      log.warn(`[everme-mcp-http] request failed: ${redactError(err)}`);
      if (!res.headersSent) {
        sendJsonRpcError(res, 500, -32603, "Internal server error");
      } else if (!res.writableEnded) {
        res.end();
      }
    }
  });

  const closeHttpServer = httpServer.close.bind(httpServer);
  httpServer.close = (callback) => {
    const result = closeHttpServer(callback);
    const cleanupPromises = [...sseSessions.values()].map((session) => session.cleanup());
    void Promise.allSettled(cleanupPromises).then(() => httpServer.closeIdleConnections?.());
    return result;
  };
  httpServer.on("close", () => {
    for (const session of sseSessions.values()) void session.cleanup();
  });
  return httpServer;
}

function routeRequest(pathname, method) {
  if (pathname === "/health") return method === "GET" ? "health" : "method-not-allowed";
  if (pathname === "/mcp") return method === "POST" ? "streamable-http" : "method-not-allowed";
  if (pathname === "/sse") return method === "GET" ? "sse-open" : "method-not-allowed";
  if (pathname === "/messages") return method === "POST" ? "sse-message" : "method-not-allowed";
  return "not-found";
}

function allowedMethods(pathname) {
  return pathname === "/sse" || pathname === "/health" ? "GET" : "POST";
}

async function authenticateRequest(req, res, { limiter, log }) {
  const agentToken = readAgentToken(req.headers.authorization);
  if (!agentToken) {
    res.setHeader("WWW-Authenticate", "Bearer");
    sendJsonRpcError(res, 401, -32001, "Unauthorized");
    return "";
  }

  let rate;
  try {
    rate = await limiter.take(agentToken);
  } catch (err) {
    log.warn(`[everme-mcp-http] token validation failed: ${redactError(err)}`);
    const unauthorized = err?.httpStatus === 401 || err?.httpStatus === 403;
    if (unauthorized) res.setHeader("WWW-Authenticate", "Bearer");
    sendJsonRpcError(
      res,
      unauthorized ? 401 : 503,
      unauthorized ? -32001 : -32004,
      unauthorized ? "Unauthorized" : "Authentication service unavailable",
    );
    return "";
  }
  if (!rate.allowed) {
    res.setHeader("Retry-After", String(rate.retryAfterSeconds));
    sendJsonRpcError(res, 429, -32002, "Too many requests");
    return "";
  }
  return agentToken;
}

async function openSseSession({
  res,
  agentToken,
  apiBase,
  log,
  sessions,
  mcpServerFactory,
  sseTransportFactory,
}) {
  const { server, dispose } = mcpServerFactory({
    logger: log,
    config: { apiBase, agentId: "", agentToken },
  });
  const transport = sseTransportFactory("/messages", res);
  transport.onerror = (err) => {
    log.warn(`[everme-mcp-http] SSE transport failed: ${redactError(err)}`);
  };

  let cleanupPromise;
  const cleanup = () => {
    if (cleanupPromise) return cleanupPromise;
    let finishCleanup;
    cleanupPromise = new Promise((resolve) => {
      finishCleanup = resolve;
    });
    void Promise.allSettled([server.close(), dispose()]).then(() => {
      sessions.delete(transport.sessionId);
      finishCleanup();
    });
    return cleanupPromise;
  };
  transport.onclose = () => void cleanup();
  res.once("close", () => void cleanup());
  sessions.set(transport.sessionId, {
    transport,
    tokenDigest: tokenDigest(agentToken),
    cleanup,
  });

  try {
    await server.connect(transport);
  } catch (err) {
    await cleanup();
    throw err;
  }
}

async function handleSseMessage({
  req,
  res,
  parsedBody,
  agentToken,
  sessionId,
  sessions,
}) {
  if (!sessionId) {
    sendJsonRpcError(res, 400, -32000, "Missing sessionId");
    return;
  }
  const session = sessions.get(sessionId);
  if (!session) {
    sendJsonRpcError(res, 404, -32000, "Session not found");
    return;
  }
  if (session.tokenDigest !== tokenDigest(agentToken)) {
    res.setHeader("WWW-Authenticate", "Bearer");
    sendJsonRpcError(res, 401, -32001, "Unauthorized");
    return;
  }
  await session.transport.handlePostMessage(req, res, parsedBody);
}

async function handleMcpRequest({
  req,
  res,
  parsedBody,
  agentToken,
  apiBase,
  log,
  mcpServerFactory,
  transportFactory,
}) {
  const { server, dispose } = mcpServerFactory({
    logger: log,
    config: { apiBase, agentId: "", agentToken },
  });
  const transport = transportFactory({ sessionIdGenerator: undefined });
  transport.onerror = (err) => {
    log.warn(`[everme-mcp-http] transport failed: ${redactError(err)}`);
  };

  let cleanupPromise;
  const cleanup = () => {
    cleanupPromise ??= Promise.allSettled([
      server.close(),
      dispose(),
    ]).then(() => undefined);
    return cleanupPromise;
  };
  res.once("finish", () => void cleanup());
  res.once("close", () => void cleanup());

  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, parsedBody);
  } catch (err) {
    await cleanup();
    throw err;
  }
  if (res.writableEnded) await cleanup();
}

function readAgentToken(header) {
  if (typeof header !== "string") return "";
  const match = /^Bearer ([^ ]+)$/.exec(header);
  if (!match || !EVT_TOKEN_RE.test(match[1])) return "";
  return match[1];
}

function tokenDigest(agentToken) {
  return createHash("sha256").update(agentToken).digest("hex");
}

function createFixedWindowLimiter({
  rateLimit,
  rateWindowMs,
  maxKeys,
  maxPendingValidations,
  now,
  validate,
}) {
  const counts = new Map();
  const pendingValidations = new Map();
  let activeBucket;

  const currentWindow = () => {
    const timestamp = Number(now());
    const bucket = Math.floor(timestamp / rateWindowMs);
    if (bucket !== activeBucket) {
      counts.clear();
      activeBucket = bucket;
    }
    return {
      timestamp,
      bucket,
      retryAfterSeconds: Math.max(
        1,
        Math.ceil(((bucket + 1) * rateWindowMs - timestamp) / 1000),
      ),
    };
  };

  return {
    async take(agentToken) {
      let window = currentWindow();
      const key = createHash("sha256").update(agentToken).digest("hex");
      let count = counts.get(key);
      if (count === undefined) {
        let validation = pendingValidations.get(key);
        if (!validation) {
          if (pendingValidations.size >= maxPendingValidations) {
            return { allowed: false, retryAfterSeconds: window.retryAfterSeconds };
          }
          validation = Promise.resolve().then(() => validate(agentToken));
          pendingValidations.set(key, validation);
        }
        try {
          await validation;
        } finally {
          if (pendingValidations.get(key) === validation) pendingValidations.delete(key);
        }

        window = currentWindow();
        count = counts.get(key);
        if (count === undefined && counts.size >= maxKeys) {
          return { allowed: false, retryAfterSeconds: window.retryAfterSeconds };
        }
        if (count === undefined) count = 0;
      }
      if (count >= rateLimit) {
        return { allowed: false, retryAfterSeconds: window.retryAfterSeconds };
      }
      counts.set(key, count + 1);
      return { allowed: true, retryAfterSeconds: 0 };
    },
  };
}

async function validateAgentToken(agentToken, { apiBase, log }) {
  const cfg = resolveConfig({ apiBase, agentId: "", agentToken });
  const client = createClient(cfg, log);
  await client.request("POST", "/mem/capabilities", {});
}

async function readJsonBody(req, maxBodyBytes) {
  const contentLength = req.headers["content-length"];
  if (/^\d+$/.test(String(contentLength || "")) && Number(contentLength) > maxBodyBytes) {
    req.resume();
    throw new RequestBodyError(413, -32003, "Request body too large");
  }

  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > maxBodyBytes) {
      req.resume();
      throw new RequestBodyError(413, -32003, "Request body too large");
    }
    chunks.push(chunk);
  }

  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new RequestBodyError(400, -32700, "Parse error: Invalid JSON");
  }
}

function readPositiveInt(value, fallback) {
  const text = String(value ?? "").trim();
  if (!/^\d+$/.test(text)) return fallback;
  const number = Number(text);
  return Number.isSafeInteger(number) && number > 0 ? number : fallback;
}

class RequestBodyError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function safeLogger(logger) {
  return {
    info: (...args) => logger.info?.(...args.map(redactLogValue)),
    warn: (...args) => logger.warn?.(...args.map(redactLogValue)),
  };
}

function redactLogValue(value) {
  return redactError(value instanceof Error ? value.message : String(value));
}

function sendJsonRpcError(res, status, code, message) {
  sendJson(res, status, {
    jsonrpc: "2.0",
    error: { code, message },
    id: null,
  });
}

function sendJson(res, status, value) {
  const body = JSON.stringify(value);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}

function createConsoleLogger() {
  return {
    info: (...args) => console.error("[everme-mcp-http]", ...args),
    warn: (...args) => console.error("[everme-mcp-http]", ...args),
  };
}

export function bootMcpHttpServer() {
  const host = process.env.HOST || "0.0.0.0";
  const port = readPositiveInt(process.env.PORT, 3000);
  const logger = createConsoleLogger();
  const server = createMcpHttpServer({ logger });

  server.on("error", (err) => {
    logger.warn(`listener failed: ${redactError(err)}`);
    process.exitCode = 1;
  });
  server.listen(port, host, () => {
    logger.info(`listening on ${host}:${port}`);
  });

  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.once(signal, () => {
      logger.info(`received ${signal}, closing`);
      server.close((err) => {
        if (err) {
          logger.warn(`shutdown failed: ${redactError(err)}`);
          process.exitCode = 1;
        }
      });
    });
  }

  return server;
}
