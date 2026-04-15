const http = require("http");
const {
  createMiddleware,
  createKafkaTransport,
  getRequestSnapshot,
  getResponseSnapshot,
  parseUserAgent,
} = require("../package");

// ─── helpers ────────────────────────────────────────────────────────────────

function section(title) {
  console.log("\n" + "═".repeat(60));
  console.log(`  ${title}`);
  console.log("═".repeat(60));
}

function log(label, value) {
  console.log(`\n[${label}]`);
  console.log(JSON.stringify(value, null, 2));
}

// ─── choose which middleware to demonstrate ───────────────────────────────────
//
//  MODE 1 — original callback API (no transport needed, works offline)
//  MODE 2 — Kafka transport        (requires a running Kafka broker)
//  MODE 3 — custom transport       (example: a plain console logger transport)
//  MODE 4 — multiple transports    (fan-out to Kafka + console at the same time)
//  MODE 5 — custom-shaped payload  (transform callback → Kafka)
//  MODE 6 — built-in flat shape      (outputFormat: 'flat', no transform)
//
const MODE = process.env.MODE || "1";

// ─── MODE 1: plain callback (original API, backward-compatible) ───────────────

function buildCallbackMiddleware() {
  section("MODE 1 — plain callback handler (original API)");
  return createMiddleware(
    (_err, payload) => {
      section("callback → payload received");
      log("timestamp", payload.timestamp);
      log("event", payload.event);
      log("durationMs", payload.durationMs);
      log("request", payload.request);
      log("response", payload.response);
    },
    {
      includeBody: true,
      highResTime: () => performance.now(),
      redactBodyKeys: ["pin", "otp"],
    },
  );
}

// ─── MODE 2: Kafka transport ──────────────────────────────────────────────────
//
//  Pass your Kafka config here.  The package connects automatically on the
//  first request and publishes each payload as a JSON message to the topic.
//
//  Required peer dep:  npm install kafkajs

function buildKafkaMiddleware() {
  section("MODE 2 — Kafka transport");

  const transport = createKafkaTransport({
    brokers: (process.env.KAFKA_BROKERS || "localhost:9092").split(","),
    clientId: process.env.KAFKA_CLIENT_ID || "my-app",
    topic: process.env.KAFKA_TOPIC || "http-logs",

    // optional — TLS example:
    // ssl: true,

    // optional — SASL/PLAIN example:
    // sasl: { mechanism: 'plain', username: 'user', password: 'pass' },

    // optional — custom message key (route each log to the same partition per URL)
    getKey: (payload) => payload.request.url || "unknown",
  });

  console.log("Kafka transport created — will connect on first request.");

  return createMiddleware(transport, {
    includeBody: true,
    highResTime: () => performance.now(),
    redactBodyKeys: ["pin", "otp"],
    onHandlerError: (err) =>
      console.error("[Kafka transport error]", err.message),
  });
}

// ─── MODE 3: custom transport (works offline — logs to console) ───────────────
//
//  Any object with a `send(payload): Promise<void>` method is a valid transport.
//  This makes it trivial to write your own: save to DB, send to webhook, etc.

function buildCustomTransport() {
  return {
    async connect() {
      console.log("[CustomTransport] connected");
    },
    async send(payload) {
      section("MODE 3 — custom transport → payload received");
      log("timestamp", payload.timestamp);
      log("event", payload.event);
      log("durationMs", payload.durationMs);
      log("request", payload.request);
      log("response", payload.response);
    },
    async disconnect() {
      console.log("[CustomTransport] disconnected");
    },
  };
}

function buildCustomMiddleware() {
  section("MODE 3 — custom transport");
  return createMiddleware(buildCustomTransport(), {
    includeBody: true,
    highResTime: () => performance.now(),
    redactBodyKeys: ["pin", "otp"],
  });
}

// ─── MODE 4: multiple transports (fan-out) ────────────────────────────────────
//
//  Pass an array — every transport receives the same payload independently.

function buildFanOutMiddleware() {
  section("MODE 4 — fan-out: Kafka + custom transport");

  const kafkaTransport = createKafkaTransport({
    brokers: (process.env.KAFKA_BROKERS || "localhost:9092").split(","),
    clientId: "my-app",
    topic: process.env.KAFKA_TOPIC || "http-logs",
  });

  const consoleTransport = buildCustomTransport();

  return createMiddleware([kafkaTransport, consoleTransport], {
    includeBody: true,
    onHandlerError: (err) => console.error("[transport error]", err.message),
  });
}

// ─── MODE 5: custom-shaped payload ───────────────────────────────────────────
//
//  Uses:
//    • captureResponseBody: true  → attaches response body to payload.response.body
//    • transform: (payload) => …  → reshapes to YOUR exact data structure
//    • parseUserAgent             → device / browser from User-Agent header
//
//  The Kafka message value will be exactly the shape you defined.

function buildShapedMiddleware() {
  section("MODE 5 — custom-shaped payload → Kafka");

  const transport = createKafkaTransport({
    brokers: (process.env.KAFKA_BROKERS || "localhost:9092").split(","),
    clientId: process.env.KAFKA_CLIENT_ID || "my-app",
    topic: process.env.KAFKA_TOPIC || "http-logs",

    // Kafka message key = the API route (groups messages by endpoint)
    getKey: (shaped) => shaped.apiRoute || "unknown",
  });

  return createMiddleware(transport, {
    includeBody: true,
    captureResponseBody: true,
    highResTime: () => performance.now(),
    onHandlerError: (err) => console.error("[Kafka error]", err.message),

    // ── userId resolution ─────────────────────────────────────────────────
    // priority: this function → req.user.id → null
    // (omit this option entirely to fall back to req.user.id automatically)
    getUserId: (req) => req.user?.id ?? null,

    // ── userRole resolution ───────────────────────────────────────────────
    // priority: this function → req.user.role → null
    getUserRole: (req) => req.user?.role ?? null,

    // ── reshape HttpLogPayload into your final data structure ─────────────
    //
    // Header key renames:
    //   x-app-name    → appName
    //   x-app-version → appVersion
    //   x-build-number→ buildNumber
    //   x-platform    → platform  (the OS: android, ios, windows…)
    //
    transform(payload, { userId, userRole }) {
      const req = payload.request;
      const resp = payload.response;
      const headers = req.headers || {};
      const ua = parseUserAgent(req.userAgent);

      return {
        requestId: req.requestId || null,

        // ── renamed header fields ─────────────────────────────────────────
        appName: headers["x-app-name"] || null,
        appVersion: headers["x-app-version"] || null,
        buildNumber: headers["x-build-number"] || null,

        // platform = x-platform header (android / ios / windows);
        // fall back to OS parsed from User-Agent
        platform: headers["x-platform"] || ua.os || null,

        apiRoute: req.url,
        apiMethod: req.method,
        userIp: req.forwardedFor || req.realIp || req.remoteAddress,

        requestBody: req.body || null,
        responseBody: resp.body || null,

        service: process.env.SERVICE_NAME || "APTS",

        responseStatus: resp.statusMessage || null,
        responseStatusCode: resp.statusCode,
        responseTime: Math.round(payload.durationMs),

        // ── user context (resolved by getUserId / getUserRole options) ─────
        userId,
        userRole,

        userDevice: headers["x-device-model"] || ua.device,
        userBrowser: ua.browser,
      };
    },
  });
}

// ─── MODE 6: built-in flat payload (no transform in consumer) ───────────────

function buildBuiltinFlatMiddleware() {
  section("MODE 6 — built-in flat payload (outputFormat: flat)");

  const transport = createKafkaTransport({
    brokers: (process.env.KAFKA_BROKERS || "localhost:9092").split(","),
    clientId: process.env.KAFKA_CLIENT_ID || "my-app",
    topic: process.env.KAFKA_TOPIC || "http-logs",
    getKey: (shaped) => shaped.apiRoute || "unknown",
  });

  return createMiddleware(transport, {
    includeBody: true,
    captureResponseBody: true,
    outputFormat: "flat",
    highResTime: () => performance.now(),
    onHandlerError: (err) => console.error("[Kafka error]", err.message),
  });
}

// ─── wire up the selected middleware ─────────────────────────────────────────

const middlewareBuilders = {
  1: buildCallbackMiddleware,
  2: buildKafkaMiddleware,
  3: buildCustomMiddleware,
  4: buildFanOutMiddleware,
  5: buildShapedMiddleware,
  6: buildBuiltinFlatMiddleware,
};

if (!middlewareBuilders[MODE]) {
  console.error(`Unknown MODE="${MODE}". Use 1, 2, 3, 4, 5, or 6.`);
  process.exit(1);
}

const logMiddleware = middlewareBuilders[MODE]();

// ─── server ──────────────────────────────────────────────────────────────────

const PORT = 3456;

const server = http.createServer((req, res) => {
  // 1️⃣  Wire the middleware
  logMiddleware(req, res, () => {});

  // 2️⃣  Collect the body
  let buf = "";
  req.on("data", (c) => {
    buf += c;
  });
  req.on("end", () => {
    if (buf) {
      try {
        req.body = JSON.parse(buf);
      } catch {
        req.body = { _raw: buf };
      }
    }

    // 3️⃣  Stand-alone snapshot (before response)
    section("getRequestSnapshot (after body parsed, before response)");
    log("snapshot", getRequestSnapshot(req, { includeBody: true }));

    // 4️⃣  Send the response
    res.writeHead(201, {
      "Content-Type": "application/json",
      "X-Request-Id": "test-id-123",
    });
    res.end(JSON.stringify({ ok: true, url: req.url }));

    // 5️⃣  Stand-alone response snapshot (after res.end)
    section("getResponseSnapshot (after res.end)");
    log("snapshot", getResponseSnapshot(res));
  });
});

// ─── test requests ────────────────────────────────────────────────────────────

async function runTests() {
  section("TEST 1 — POST /auth/login  (sensitive body + Authorization header)");
  await fetch(`http://127.0.0.1:${PORT}/auth/login?redirect=%2Fdashboard`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer super-secret-token",
      "X-Request-Id": "req-001",
    },
    body: JSON.stringify({
      email: "user@example.com",
      password: "should-be-redacted",
      pin: "1234",
      otp: "567890",
    }),
  });

  section("TEST 2 — GET /users/:id  (query + params from URL)");
  await fetch(
    `http://127.0.0.1:${PORT}/users/42?include=profile&include=settings`,
    {
      method: "GET",
      headers: { Accept: "application/json" },
    },
  );

  server.close();
}

console.log(`\nStarting server in MODE ${MODE} on port ${PORT}…`);
server.listen(PORT, () => runTests());
