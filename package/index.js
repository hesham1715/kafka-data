"use strict";

const SENSITIVE_HEADER_NAMES = new Set([
  "authorization",
  "cookie",
  "set-cookie",
  "x-api-key",
  "proxy-authorization",
]);

const DEFAULT_SENSITIVE_BODY_KEYS = new Set([
  "password",
  "passwd",
  "secret",
  "token",
  "access_token",
  "refresh_token",
  "authorization",
  "credit_card",
  "creditcard",
  "cvv",
  "ssn",
]);

const DEFAULT_OPTIONS = {
  redactSensitiveHeaders: true,
  redactBodyKeys: null,
  maxBodyDepth: 8,
  maxBodyKeys: 200,
  maxArrayElements: 100,
  maxStringLength: 10_000,
  includeBody: true,
  includeRawBody: false,
  maxResponseBodyBytes: 1024 * 1024,
};

function normalizeBodyKeys(keys) {
  if (!keys) return new Set(DEFAULT_SENSITIVE_BODY_KEYS);
  const s = new Set(DEFAULT_SENSITIVE_BODY_KEYS);
  for (const k of keys) {
    if (typeof k === "string") s.add(k.toLowerCase());
  }
  return s;
}

function pickHeaders(headers, options = {}) {
  const { redactSensitiveHeaders = true } = options;
  const out = {};
  if (!headers || typeof headers !== "object") return out;

  const entries =
    typeof headers.entries === "function"
      ? [...headers.entries()]
      : Object.entries(headers);

  for (const [name, value] of entries) {
    const key = String(name).toLowerCase();
    let v = value;
    if (Array.isArray(v)) v = v.join(", ");
    if (redactSensitiveHeaders && SENSITIVE_HEADER_NAMES.has(key)) {
      out[name] = "[REDACTED]";
    } else {
      out[name] = v;
    }
  }
  return out;
}

function cloneForLog(value, opts, depth, seen) {
  const {
    redactBodyKeys,
    maxBodyDepth,
    maxBodyKeys,
    maxArrayElements,
    maxStringLength,
  } = opts;

  if (depth > maxBodyDepth) return "[MaxDepth]";
  if (value === null || value === undefined) return value;

  const t = typeof value;
  if (t === "string") {
    return value.length > maxStringLength
      ? `${value.slice(0, maxStringLength)}…[truncated]`
      : value;
  }
  if (t === "number" || t === "boolean" || t === "bigint") return value;
  if (t === "function") return "[Function]";
  if (value instanceof Date) return value.toISOString();
  if (Buffer.isBuffer(value)) {
    const hex = value.toString("hex");
    return hex.length > maxStringLength
      ? `${hex.slice(0, maxStringLength)}…[truncated]`
      : hex;
  }

  if (typeof value === "object") {
    if (seen.has(value)) return "[Circular]";
    seen.add(value);

    if (Array.isArray(value)) {
      const slice = value.slice(0, maxArrayElements);
      const arr = slice.map((item) => cloneForLog(item, opts, depth + 1, seen));
      if (value.length > maxArrayElements) {
        arr.push(`…[+${value.length - maxArrayElements} more]`);
      }
      seen.delete(value);
      return arr;
    }

    const keys = Object.keys(value).slice(0, maxBodyKeys);
    const out = {};
    for (const k of keys) {
      const lk = k.toLowerCase();
      if (redactBodyKeys.has(lk)) {
        out[k] = "[REDACTED]";
      } else {
        out[k] = cloneForLog(value[k], opts, depth + 1, seen);
      }
    }
    const totalKeys = Object.keys(value).length;
    if (totalKeys > maxBodyKeys) {
      out["…"] = `[+${totalKeys - maxBodyKeys} more keys]`;
    }
    seen.delete(value);
    return out;
  }

  return String(value);
}

function sanitizeBody(body, options) {
  if (body === undefined) return undefined;
  const opts = {
    ...DEFAULT_OPTIONS,
    ...options,
    redactBodyKeys: normalizeBodyKeys(options.redactBodyKeys),
    maxBodyDepth: options.maxBodyDepth ?? DEFAULT_OPTIONS.maxBodyDepth,
    maxBodyKeys: options.maxBodyKeys ?? DEFAULT_OPTIONS.maxBodyKeys,
    maxArrayElements:
      options.maxArrayElements ?? DEFAULT_OPTIONS.maxArrayElements,
    maxStringLength: options.maxStringLength ?? DEFAULT_OPTIONS.maxStringLength,
  };
  try {
    return cloneForLog(body, opts, 0, new WeakSet());
  } catch {
    return "[Unserializable body]";
  }
}

function parseQueryFromUrl(url) {
  if (typeof url !== "string") return undefined;
  const q = url.indexOf("?");
  if (q === -1) return undefined;
  try {
    const params = new URLSearchParams(url.slice(q + 1));
    const out = {};
    for (const [k, v] of params) {
      if (k in out) {
        const cur = out[k];
        out[k] = Array.isArray(cur) ? [...cur, v] : [cur, v];
      } else {
        out[k] = v;
      }
    }
    return out;
  } catch {
    return undefined;
  }
}

function getRequestSnapshot(req, options = {}) {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  const socket = req.socket || {};
  const headers = req.headers || {};

  const express = typeof req.originalUrl === "string";

  const snapshot = {
    method: req.method,
    httpVersion: req.httpVersion,

    url: req.url,
    ...(express && {
      originalUrl: req.originalUrl,
      baseUrl: req.baseUrl,
      path: req.path,
      route: req.route && req.route.path,
    }),

    query:
      req.query && typeof req.query === "object"
        ? { ...req.query }
        : parseQueryFromUrl(req.url),
    params:
      req.params && typeof req.params === "object"
        ? { ...req.params }
        : undefined,

    headers: pickHeaders(headers, opts),

    remoteAddress: socket.remoteAddress,
    remotePort: socket.remotePort,
    localAddress: socket.localAddress,
    localPort: socket.localPort,

    forwardedFor: headers["x-forwarded-for"],
    forwardedProto: headers["x-forwarded-proto"],
    forwardedHost: headers["x-forwarded-host"],
    realIp: headers["x-real-ip"],

    ...(typeof req.ip === "string" && { ip: req.ip }),
    ...(Array.isArray(req.ips) && { ips: [...req.ips] }),
    ...(typeof req.hostname === "string" && { hostname: req.hostname }),
    ...(typeof req.protocol === "string" && { protocol: req.protocol }),
    ...(typeof req.secure === "boolean" && { secure: req.secure }),

    requestId:
      headers["x-request-id"] ||
      headers["x-correlation-id"] ||
      headers["traceparent"] ||
      req.requestId ||
      undefined,

    contentType: headers["content-type"],
    contentLength: headers["content-length"],
    userAgent: headers["user-agent"],
    accept: headers.accept,
    referer: headers.referer || headers.referrer,
  };

  if (opts.includeBody && req.body !== undefined) {
    snapshot.body = sanitizeBody(req.body, opts);
  }

  if (opts.includeRawBody && req.rawBody !== undefined) {
    const raw = req.rawBody;
    if (Buffer.isBuffer(raw)) {
      const s = raw.toString("utf8");
      snapshot.rawBody =
        s.length > opts.maxStringLength
          ? `${s.slice(0, opts.maxStringLength)}…[truncated]`
          : s;
    } else if (typeof raw === "string") {
      snapshot.rawBody =
        raw.length > opts.maxStringLength
          ? `${raw.slice(0, opts.maxStringLength)}…[truncated]`
          : raw;
    }
  }

  return snapshot;
}

function getOutgoingHeaders(res) {
  if (typeof res.getHeaders !== "function") return {};
  const h = res.getHeaders();
  if (h && Object.keys(h).length > 0) return h;
  if (typeof res.getHeaderNames !== "function") return {};
  const out = {};
  for (const name of res.getHeaderNames()) {
    const v = res.getHeader(name);
    if (v !== undefined) out[name] = v;
  }
  return out;
}

function getResponseSnapshot(res) {
  return {
    statusCode: res.statusCode,
    statusMessage: res.statusMessage,
    headers: pickHeaders(getOutgoingHeaders(res), {
      redactSensitiveHeaders: true,
    }),
    headersSent: res.headersSent,
    finished: res.finished,
    writableEnded: res.writableEnded,
    // populated when captureResponseBody: true is used
    ...(res._responseBody !== undefined && { body: res._responseBody }),
  };
}

/**
 * Parses a User-Agent string into `{ device, browser, os }`.
 *
 * These are best-effort heuristics. For production-grade detection,
 * replace with a library such as `ua-parser-js`.
 *
 * @param {string} [ua]
 * @returns {{ device: string, browser: string, os: string }}
 */
function parseUserAgent(ua) {
  if (!ua || typeof ua !== "string") {
    return { device: "Unknown", browser: "Unknown", os: "Unknown" };
  }

  let device = "Desktop";
  if (/android/i.test(ua)) device = "Android";
  else if (/iphone/i.test(ua)) device = "iPhone";
  else if (/ipad/i.test(ua)) device = "iPad";
  else if (/mobile/i.test(ua)) device = "Mobile";

  let os = "Unknown";
  if (/android/i.test(ua)) os = "Android";
  else if (/iphone|ipad|ios/i.test(ua)) os = "iOS";
  else if (/windows nt/i.test(ua)) os = "Windows";
  else if (/mac os x/i.test(ua)) os = "macOS";
  else if (/linux/i.test(ua)) os = "Linux";

  let browser = "Unknown";
  if (/edg\//i.test(ua)) browser = "Edge";
  else if (/opr\//i.test(ua)) browser = "Opera";
  else if (/chrome/i.test(ua)) browser = "Chrome";
  else if (/firefox/i.test(ua)) browser = "Firefox";
  else if (/safari/i.test(ua)) browser = "Safari";

  return { device, browser, os };
}

/**
 * Resolves userId / userRole from options and req.user.
 * @param {import('http').IncomingMessage} req
 * @param {object} [options]
 */
function resolveUserContext(req, options = {}) {
  let userId = null;
  if (typeof options.getUserId === "function") {
    userId = options.getUserId(req) ?? null;
  } else if (options.getUserId !== undefined) {
    userId = options.getUserId ?? null;
  } else {
    userId = req.user && req.user.id !== undefined ? req.user.id : null;
  }

  let userRole = null;
  if (typeof options.getUserRole === "function") {
    userRole = options.getUserRole(req) ?? null;
  } else if (options.getUserRole !== undefined) {
    userRole = options.getUserRole ?? null;
  } else {
    userRole = req.user && req.user.role !== undefined ? req.user.role : null;
  }

  return { userId, userRole };
}

/**
 * Built-in flat log shape (no consumer `transform` required).
 * Use `outputFormat: 'flat'` in createMiddleware / onResponseComplete options.
 *
 * @param {object} payload - HttpLogPayload from onResponseComplete
 * @param {{ userId: unknown, userRole: unknown }} ctx
 * @param {object} [options] - middleware options (serviceName, etc.)
 */
function buildFlatLogPayload(payload, ctx, options = {}) {
  const { userId, userRole } = ctx;
  const req = payload.request;
  const resp = payload.response;
  const headers = req.headers || {};
  const ua = parseUserAgent(req.userAgent);

  const service =
    (typeof options.serviceName === "string" && options.serviceName) ||
    (typeof process !== "undefined" &&
      process.env &&
      typeof process.env.SERVICE_NAME === "string" &&
      process.env.SERVICE_NAME) ||
    "APTS";

  return {
    requestId: req.requestId ?? null,
    appName: headers["x-app-name"] ?? null,
    appVersion: headers["x-app-version"] ?? null,
    buildNumber: headers["x-build-number"] ?? null,
    platform: headers["x-platform"] ?? ua.os ?? null,
    apiRoute: req.url,
    apiMethod: req.method,
    userIp: req.forwardedFor || req.realIp || req.remoteAddress,
    requestBody: req.body ?? null,
    responseBody: resp.body ?? null,
    service,
    responseStatus: resp.statusMessage ?? null,
    responseStatusCode: resp.statusCode,
    responseTime: Math.round(payload.durationMs),
    userId,
    userRole,
    userDevice: ua.device,
    userBrowser: ua.browser,
  };
}

/**
 * Applies optional `transform`, or built-in `outputFormat`, or merges user context
 * into the default nested payload.
 *
 * @param {object} payload
 * @param {import('http').IncomingMessage} req
 * @param {import('http').ServerResponse} res
 * @param {object} [options]
 */
function finalizeLogPayload(payload, req, res, options = {}) {
  const { userId, userRole } = resolveUserContext(req, options);
  const context = { userId, userRole, req, res };

  if (typeof options.transform === "function") {
    return options.transform(payload, context);
  }

  const outputFormat = options.outputFormat ?? "nested";
  if (outputFormat === "flat") {
    return buildFlatLogPayload(payload, { userId, userRole }, options);
  }

  return { ...payload, userId, userRole };
}

function onResponseComplete(req, res, handler, options = {}) {
  if (typeof handler !== "function") {
    throw new TypeError("onResponseComplete: handler must be a function");
  }

  // ── optionally capture the response body ─────────────────────────────────
  if (options.captureResponseBody) {
    const chunks = [];
    const originalWrite = res.write.bind(res);
    const originalEnd = res.end.bind(res);

    res.write = function capturedWrite(chunk, ...args) {
      if (chunk != null) {
        chunks.push(
          Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)),
        );
      }
      return originalWrite(chunk, ...args);
    };

    res.end = function capturedEnd(chunk, ...args) {
      if (chunk != null) {
        chunks.push(
          Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)),
        );
      }
      const rawBuffer = Buffer.concat(chunks);

      // Read req.logOptions lazily here so NestJS interceptors (which run after
      // middleware but before res.end) can override the limit per-route.
      const requestOverrideBytes =
        req &&
        req.logOptions &&
        typeof req.logOptions === "object" &&
        req.logOptions.maxResponseBodyBytes !== undefined
          ? req.logOptions.maxResponseBodyBytes
          : undefined;
      const resolvedMaxResponseBodyBytes = Number(
        requestOverrideBytes ??
          options.maxResponseBodyBytes ??
          DEFAULT_OPTIONS.maxResponseBodyBytes,
      );
      const shouldLimitResponseBody =
        Number.isFinite(resolvedMaxResponseBodyBytes) &&
        resolvedMaxResponseBodyBytes >= 0;

      if (
        shouldLimitResponseBody &&
        rawBuffer.length > resolvedMaxResponseBodyBytes
      ) {
        res._responseBody = undefined;
        return originalEnd(chunk, ...args);
      }
      const raw = rawBuffer.toString("utf8");
      try {
        res._responseBody = raw ? JSON.parse(raw) : undefined;
      } catch {
        res._responseBody = raw || undefined;
      }
      return originalEnd(chunk, ...args);
    };
  }

  const startWall = Date.now();
  const startHR =
    typeof options.highResTime === "function"
      ? options.highResTime()
      : startWall;

  let settled = false;

  function finish(event) {
    if (settled) return;
    settled = true;

    const endHR =
      typeof options.highResTime === "function"
        ? options.highResTime()
        : Date.now();

    const durationMs = endHR - startHR;
    // Snapshot request when the response ends so `req.body` / `req.query` etc.
    // are populated (Nest/Express body-parser runs before route handlers).
    const payload = {
      timestamp: new Date(startWall).toISOString(),
      event,
      durationMs,
      request: getRequestSnapshot(req, options),
      response: getResponseSnapshot(res),
    };

    try {
      handler(null, payload);
    } catch (err) {
      if (typeof options.onHandlerError === "function") {
        options.onHandlerError(err);
      }
    }
  }

  res.on("finish", () => finish("finish"));
  res.on("close", () => {
    if (!res.writableFinished) finish("close");
  });

  return () => {
    if (!settled) finish("manual");
  };
}

/**
 * Returns a ready-made Express/Nest middleware function `(req, res, next) => void`.
 *
 * Accepts one of three forms for the first argument:
 *
 * 1. Callback handler (original API — backward-compatible):
 *      createMiddleware((err, payload) => logger.log(payload), options)
 *
 * 2. A single transport object  { send(payload): Promise<void>, ... }:
 *      createMiddleware(kafkaTransport, options)
 *
 * 3. An array of transport objects (fan-out to all):
 *      createMiddleware([kafkaTransport, webhookTransport], options)
 */
function createMiddleware(transportOrHandler, options = {}) {
  const { onHandlerError } = options;

  // ── Form 1: plain callback (original API) ──────────────────────────────────
  if (typeof transportOrHandler === "function") {
    return function httpLogMiddleware(req, res, next) {
      function wrappedHandler(err, payload) {
        let finalized;
        try {
          finalized = finalizeLogPayload(payload, req, res, options);
        } catch (finalizeErr) {
          if (typeof onHandlerError === "function") {
            onHandlerError(finalizeErr);
          } else {
            console.error("[http-log] finalize error:", finalizeErr);
          }
          return;
        }
        transportOrHandler(err, finalized);
      }
      onResponseComplete(req, res, wrappedHandler, options);
      if (typeof next === "function") next();
    };
  }

  // ── Forms 2 & 3: transport object or array of transports ───────────────────
  const transports = Array.isArray(transportOrHandler)
    ? transportOrHandler
    : [transportOrHandler];

  if (transports.length === 0) {
    throw new TypeError("createMiddleware: transports array must not be empty");
  }

  for (const t of transports) {
    if (!t || typeof t.send !== "function") {
      throw new TypeError(
        "createMiddleware: each transport must be an object with a send(payload) method",
      );
    }
  }

  return function httpLogMiddleware(req, res, next) {
    // ── handler is created per-request so it can close over req/res ──────────
    function handler(_err, payload) {
      let finalPayload;
      try {
        finalPayload = finalizeLogPayload(payload, req, res, options);
      } catch (err) {
        if (typeof onHandlerError === "function") {
          onHandlerError(err);
        } else {
          console.error("[http-log] finalize error:", err);
        }
        return;
      }

      for (const transport of transports) {
        Promise.resolve(transport.send(finalPayload)).catch((err) => {
          if (typeof onHandlerError === "function") {
            onHandlerError(err);
          } else {
            console.error("[http-log] transport error:", err);
          }
        });
      }
    }

    onResponseComplete(req, res, handler, options);
    if (typeof next === "function") next();
  };
}

const { createKafkaTransport } = require("./transports/kafka");

module.exports = {
  getRequestSnapshot,
  getResponseSnapshot,
  onResponseComplete,
  createMiddleware,
  pickHeaders,
  sanitizeBody,
  parseUserAgent,
  DEFAULT_OPTIONS,
  SENSITIVE_HEADER_NAMES,
  // transports
  createKafkaTransport,
};
