'use strict';

const SENSITIVE_HEADER_NAMES = new Set([
  'authorization',
  'cookie',
  'set-cookie',
  'x-api-key',
  'proxy-authorization',
]);

const DEFAULT_SENSITIVE_BODY_KEYS = new Set([
  'password',
  'passwd',
  'secret',
  'token',
  'access_token',
  'refresh_token',
  'authorization',
  'credit_card',
  'creditcard',
  'cvv',
  'ssn',
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
};

function normalizeBodyKeys(keys) {
  if (!keys) return new Set(DEFAULT_SENSITIVE_BODY_KEYS);
  const s = new Set(DEFAULT_SENSITIVE_BODY_KEYS);
  for (const k of keys) {
    if (typeof k === 'string') s.add(k.toLowerCase());
  }
  return s;
}

function pickHeaders(headers, options = {}) {
  const { redactSensitiveHeaders = true } = options;
  const out = {};
  if (!headers || typeof headers !== 'object') return out;

  const entries = typeof headers.entries === 'function'
    ? [...headers.entries()]
    : Object.entries(headers);

  for (const [name, value] of entries) {
    const key = String(name).toLowerCase();
    let v = value;
    if (Array.isArray(v)) v = v.join(', ');
    if (redactSensitiveHeaders && SENSITIVE_HEADER_NAMES.has(key)) {
      out[name] = '[REDACTED]';
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

  if (depth > maxBodyDepth) return '[MaxDepth]';
  if (value === null || value === undefined) return value;

  const t = typeof value;
  if (t === 'string') {
    return value.length > maxStringLength
      ? `${value.slice(0, maxStringLength)}…[truncated]`
      : value;
  }
  if (t === 'number' || t === 'boolean' || t === 'bigint') return value;
  if (t === 'function') return '[Function]';
  if (value instanceof Date) return value.toISOString();
  if (Buffer.isBuffer(value)) {
    const hex = value.toString('hex');
    return hex.length > maxStringLength
      ? `${hex.slice(0, maxStringLength)}…[truncated]`
      : hex;
  }

  if (typeof value === 'object') {
    if (seen.has(value)) return '[Circular]';
    seen.add(value);

    if (Array.isArray(value)) {
      const slice = value.slice(0, maxArrayElements);
      const arr = slice.map((item) =>
        cloneForLog(item, opts, depth + 1, seen),
      );
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
        out[k] = '[REDACTED]';
      } else {
        out[k] = cloneForLog(value[k], opts, depth + 1, seen);
      }
    }
    const totalKeys = Object.keys(value).length;
    if (totalKeys > maxBodyKeys) {
      out['…'] = `[+${totalKeys - maxBodyKeys} more keys]`;
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
    maxArrayElements: options.maxArrayElements ?? DEFAULT_OPTIONS.maxArrayElements,
    maxStringLength: options.maxStringLength ?? DEFAULT_OPTIONS.maxStringLength,
  };
  try {
    return cloneForLog(body, opts, 0, new WeakSet());
  } catch {
    return '[Unserializable body]';
  }
}

function parseQueryFromUrl(url) {
  if (typeof url !== 'string') return undefined;
  const q = url.indexOf('?');
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

  const express = typeof req.originalUrl === 'string';

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
      req.query && typeof req.query === 'object'
        ? { ...req.query }
        : parseQueryFromUrl(req.url),
    params: req.params && typeof req.params === 'object' ? { ...req.params } : undefined,

    headers: pickHeaders(headers, opts),

    remoteAddress: socket.remoteAddress,
    remotePort: socket.remotePort,
    localAddress: socket.localAddress,
    localPort: socket.localPort,

    forwardedFor: headers['x-forwarded-for'],
    forwardedProto: headers['x-forwarded-proto'],
    forwardedHost: headers['x-forwarded-host'],
    realIp: headers['x-real-ip'],

    ...(typeof req.ip === 'string' && { ip: req.ip }),
    ...(Array.isArray(req.ips) && { ips: [...req.ips] }),
    ...(typeof req.hostname === 'string' && { hostname: req.hostname }),
    ...(typeof req.protocol === 'string' && { protocol: req.protocol }),
    ...(typeof req.secure === 'boolean' && { secure: req.secure }),

    requestId:
      headers['x-request-id'] ||
      headers['x-correlation-id'] ||
      headers['traceparent'] ||
      undefined,

    contentType: headers['content-type'],
    contentLength: headers['content-length'],
    userAgent: headers['user-agent'],
    accept: headers.accept,
    referer: headers.referer || headers.referrer,
  };

  if (opts.includeBody && req.body !== undefined) {
    snapshot.body = sanitizeBody(req.body, opts);
  }

  if (opts.includeRawBody && req.rawBody !== undefined) {
    const raw = req.rawBody;
    if (Buffer.isBuffer(raw)) {
      const s = raw.toString('utf8');
      snapshot.rawBody =
        s.length > opts.maxStringLength
          ? `${s.slice(0, opts.maxStringLength)}…[truncated]`
          : s;
    } else if (typeof raw === 'string') {
      snapshot.rawBody =
        raw.length > opts.maxStringLength
          ? `${raw.slice(0, opts.maxStringLength)}…[truncated]`
          : raw;
    }
  }

  return snapshot;
}

function getOutgoingHeaders(res) {
  if (typeof res.getHeaders !== 'function') return {};
  const h = res.getHeaders();
  if (h && Object.keys(h).length > 0) return h;
  if (typeof res.getHeaderNames !== 'function') return {};
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
  };
}

function onResponseComplete(req, res, handler, options = {}) {
  if (typeof handler !== 'function') {
    throw new TypeError('onResponseComplete: handler must be a function');
  }

  const startWall = Date.now();
  const startHR = typeof options.highResTime === 'function'
    ? options.highResTime()
    : startWall;

  let settled = false;

  function finish(event) {
    if (settled) return;
    settled = true;

    const endHR = typeof options.highResTime === 'function'
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
      if (typeof options.onHandlerError === 'function') {
        options.onHandlerError(err);
      }
    }
  }

  res.on('finish', () => finish('finish'));
  res.on('close', () => {
    if (!res.writableFinished) finish('close');
  });

  return () => {
    if (!settled) finish('manual');
  };
}

/**
 * Returns a ready-made Express/Nest middleware function `(req, res, next) => void`.
 *
 * Usage in Nest AppModule:
 *   consumer.apply(createMiddleware((err, payload) => logger.log(payload))).forRoutes('*');
 *
 * Usage in main.ts:
 *   app.use(createMiddleware((err, payload) => logger.log(payload), { includeBody: true }));
 */
function createMiddleware(handler, options = {}) {
  if (typeof handler !== 'function') {
    throw new TypeError('createMiddleware: handler must be a function');
  }
  return function httpLogMiddleware(req, res, next) {
    onResponseComplete(req, res, handler, options);
    if (typeof next === 'function') next();
  };
}

module.exports = {
  getRequestSnapshot,
  getResponseSnapshot,
  onResponseComplete,
  createMiddleware,
  pickHeaders,
  sanitizeBody,
  DEFAULT_OPTIONS,
  SENSITIVE_HEADER_NAMES,
};
