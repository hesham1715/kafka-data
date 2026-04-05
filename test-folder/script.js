const http = require('http');
const {
  createMiddleware,
  createKafkaTransport,
  getRequestSnapshot,
  getResponseSnapshot,
} = require('../package');

// ─── helpers ────────────────────────────────────────────────────────────────

function section(title) {
  console.log('\n' + '═'.repeat(60));
  console.log(`  ${title}`);
  console.log('═'.repeat(60));
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
//
const MODE = process.env.MODE || '1';

// ─── MODE 1: plain callback (original API, backward-compatible) ───────────────

function buildCallbackMiddleware() {
  section('MODE 1 — plain callback handler (original API)');
  return createMiddleware(
    (_err, payload) => {
      section('callback → payload received');
      log('timestamp',  payload.timestamp);
      log('event',      payload.event);
      log('durationMs', payload.durationMs);
      log('request',    payload.request);
      log('response',   payload.response);
    },
    {
      includeBody:    true,
      highResTime:    () => performance.now(),
      redactBodyKeys: ['pin', 'otp'],
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
  section('MODE 2 — Kafka transport');

  const transport = createKafkaTransport({
    brokers:  (process.env.KAFKA_BROKERS || 'localhost:9092').split(','),
    clientId: process.env.KAFKA_CLIENT_ID || 'my-app',
    topic:    process.env.KAFKA_TOPIC     || 'http-logs',

    // optional — TLS example:
    // ssl: true,

    // optional — SASL/PLAIN example:
    // sasl: { mechanism: 'plain', username: 'user', password: 'pass' },

    // optional — custom message key (route each log to the same partition per URL)
    getKey: (payload) => payload.request.url || 'unknown',
  });

  console.log('Kafka transport created — will connect on first request.');

  return createMiddleware(transport, {
    includeBody:    true,
    highResTime:    () => performance.now(),
    redactBodyKeys: ['pin', 'otp'],
    onHandlerError: (err) => console.error('[Kafka transport error]', err.message),
  });
}

// ─── MODE 3: custom transport (works offline — logs to console) ───────────────
//
//  Any object with a `send(payload): Promise<void>` method is a valid transport.
//  This makes it trivial to write your own: save to DB, send to webhook, etc.

function buildCustomTransport() {
  return {
    async connect() {
      console.log('[CustomTransport] connected');
    },
    async send(payload) {
      section('MODE 3 — custom transport → payload received');
      log('timestamp',  payload.timestamp);
      log('event',      payload.event);
      log('durationMs', payload.durationMs);
      log('request',    payload.request);
      log('response',   payload.response);
    },
    async disconnect() {
      console.log('[CustomTransport] disconnected');
    },
  };
}

function buildCustomMiddleware() {
  section('MODE 3 — custom transport');
  return createMiddleware(buildCustomTransport(), {
    includeBody:    true,
    highResTime:    () => performance.now(),
    redactBodyKeys: ['pin', 'otp'],
  });
}

// ─── MODE 4: multiple transports (fan-out) ────────────────────────────────────
//
//  Pass an array — every transport receives the same payload independently.

function buildFanOutMiddleware() {
  section('MODE 4 — fan-out: Kafka + custom transport');

  const kafkaTransport = createKafkaTransport({
    brokers:  (process.env.KAFKA_BROKERS || 'localhost:9092').split(','),
    clientId: 'my-app',
    topic:    process.env.KAFKA_TOPIC || 'http-logs',
  });

  const consoleTransport = buildCustomTransport();

  return createMiddleware([kafkaTransport, consoleTransport], {
    includeBody:    true,
    onHandlerError: (err) => console.error('[transport error]', err.message),
  });
}

// ─── wire up the selected middleware ─────────────────────────────────────────

const middlewareBuilders = {
  '1': buildCallbackMiddleware,
  '2': buildKafkaMiddleware,
  '3': buildCustomMiddleware,
  '4': buildFanOutMiddleware,
};

if (!middlewareBuilders[MODE]) {
  console.error(`Unknown MODE="${MODE}". Use 1, 2, 3, or 4.`);
  process.exit(1);
}

const logMiddleware = middlewareBuilders[MODE]();

// ─── server ──────────────────────────────────────────────────────────────────

const PORT = 3456;

const server = http.createServer((req, res) => {

  // 1️⃣  Wire the middleware
  logMiddleware(req, res, () => {});

  // 2️⃣  Collect the body
  let buf = '';
  req.on('data', (c) => { buf += c; });
  req.on('end', () => {
    if (buf) {
      try { req.body = JSON.parse(buf); }
      catch { req.body = { _raw: buf }; }
    }

    // 3️⃣  Stand-alone snapshot (before response)
    section('getRequestSnapshot (after body parsed, before response)');
    log('snapshot', getRequestSnapshot(req, { includeBody: true }));

    // 4️⃣  Send the response
    res.writeHead(201, {
      'Content-Type': 'application/json',
      'X-Request-Id': 'test-id-123',
    });
    res.end(JSON.stringify({ ok: true, url: req.url }));

    // 5️⃣  Stand-alone response snapshot (after res.end)
    section('getResponseSnapshot (after res.end)');
    log('snapshot', getResponseSnapshot(res));
  });
});

// ─── test requests ────────────────────────────────────────────────────────────

async function runTests() {
  section('TEST 1 — POST /auth/login  (sensitive body + Authorization header)');
  await fetch(`http://127.0.0.1:${PORT}/auth/login?redirect=%2Fdashboard`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization:  'Bearer super-secret-token',
      'X-Request-Id': 'req-001',
    },
    body: JSON.stringify({
      email:    'user@example.com',
      password: 'should-be-redacted',
      pin:      '1234',
      otp:      '567890',
    }),
  });

  section('TEST 2 — GET /users/:id  (query + params from URL)');
  await fetch(`http://127.0.0.1:${PORT}/users/42?include=profile&include=settings`, {
    method: 'GET',
    headers: { Accept: 'application/json' },
  });

  server.close();
}

console.log(`\nStarting server in MODE ${MODE} on port ${PORT}…`);
server.listen(PORT, () => runTests());
