const http = require('http');
const {
  createMiddleware,
  getRequestSnapshot,
  getResponseSnapshot,
  onResponseComplete,
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

// ─── middleware (the Nest-style entry point) ─────────────────────────────────

const logMiddleware = createMiddleware(
  (_err, payload) => {
    section('createMiddleware → payload on response finish');
    log('timestamp',    payload.timestamp);
    log('event',        payload.event);
    log('durationMs',   payload.durationMs);
    log('request',      payload.request);
    log('response',     payload.response);
  },
  {
    includeBody:  true,
    highResTime:  () => performance.now(),
    redactBodyKeys: ['pin', 'otp'],       // extra keys to redact on top of defaults
  },
);

// ─── server ──────────────────────────────────────────────────────────────────

const PORT = 3456;

const server = http.createServer((req, res) => {

  // 1️⃣  Wire the middleware (what you call in Nest AppModule / main.ts)
  logMiddleware(req, res, () => {});

  // 2️⃣  Manually collect the body (Nest's body-parser does this automatically)
  let buf = '';
  req.on('data', (c) => { buf += c; });
  req.on('end', () => {
    if (buf) {
      try { req.body = JSON.parse(buf); }
      catch { req.body = { _raw: buf }; }
    }

    // 3️⃣  getRequestSnapshot — stand-alone snapshot AFTER body is set
    section('getRequestSnapshot (after body parsed, before response)');
    log('snapshot', getRequestSnapshot(req, { includeBody: true }));

    // 4️⃣  Send the response
    res.writeHead(201, {
      'Content-Type': 'application/json',
      'X-Request-Id': 'test-id-123',
    });
    res.end(JSON.stringify({ ok: true, url: req.url }));

    // 5️⃣  getResponseSnapshot — stand-alone snapshot AFTER res.end()
    section('getResponseSnapshot (after res.end)');
    log('snapshot', getResponseSnapshot(res));
  });
});

// ─── test requests ────────────────────────────────────────────────────────────

async function runTests() {
  // Test 1 — POST with sensitive body + sensitive header
  section('TEST 1 — POST /auth/login  (sensitive body + Authorization header)');
  await fetch(`http://127.0.0.1:${PORT}/auth/login?redirect=%2Fdashboard`, {
    method: 'POST',
    headers: {
      'Content-Type':  'application/json',
      Authorization:   'Bearer super-secret-token',
      'X-Request-Id':  'req-001',
    },
    body: JSON.stringify({
      email:    'user@example.com',
      password: 'should-be-redacted',
      pin:      '1234',           // custom redact key we added above
      otp:      '567890',         // custom redact key we added above
    }),
  });

  // Test 2 — GET with query params, no body
  section('TEST 2 — GET /users/:id  (query + params from URL)');
  await fetch(`http://127.0.0.1:${PORT}/users/42?include=profile&include=settings`, {
    method: 'GET',
    headers: { Accept: 'application/json' },
  });

  // Test 3 — onResponseComplete used directly (raw, without createMiddleware)
  section('TEST 3 — onResponseComplete used directly');
  await new Promise((resolve) => {
    const opts = {
      hostname: '127.0.0.1', port: PORT,
      path: '/raw-test',
      method: 'DELETE',
    };
    const req = http.request(opts, (res) => {
      res.resume();
      res.on('end', resolve);
    });
    req.end();
  });

  server.close();
}

server.listen(PORT, () => runTests());
