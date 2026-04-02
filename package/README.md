# data-for-logs

Structured HTTP request/response snapshots for server logging and observability.  
Works with **raw Node `http`**, **Express**, and **NestJS (Express adapter)**.

Captures everything useful from a request and its response — URL, query, params,  
headers, body, IP, timing, status — with **automatic redaction** of secrets.

---

## Installation

```bash
npm install data-for-logs
```

---

## What you get in every log payload

```json
{
  "timestamp": "2026-04-02T12:00:00.000Z",
  "event": "finish",
  "durationMs": 12.4,
  "request": {
    "method": "POST",
    "url": "/auth/login",
    "originalUrl": "/auth/login",
    "path": "/auth/login",
    "route": "/auth/login",
    "query": {},
    "params": {},
    "headers": {
      "content-type": "application/json",
      "authorization": "[REDACTED]"
    },
    "body": {
      "email": "user@example.com",
      "password": "[REDACTED]"
    },
    "ip": "203.0.113.10",
    "remoteAddress": "::ffff:127.0.0.1",
    "requestId": "x-request-id value (or correlation-id / traceparent)",
    "userAgent": "...",
    "contentType": "application/json"
  },
  "response": {
    "statusCode": 201,
    "statusMessage": "Created",
    "headers": { "content-type": "application/json" },
    "headersSent": true,
    "finished": true
  }
}
```

---

## Usage in NestJS

### 1. Create the middleware file

```typescript
// src/http-log.middleware.ts
import { Injectable, NestMiddleware } from '@nestjs/common';
import { Request, Response, NextFunction } from 'express';
import { createMiddleware } from 'data-for-logs';

const logMiddleware = createMiddleware(
  (_err, payload) => {
    console.log(JSON.stringify(payload)); // replace with your logger / Kafka producer
  },
  {
    includeBody: true,
    highResTime: () => performance.now(),
    redactBodyKeys: ['pin', 'otp', 'card_number'], // merged with built-in list
  },
);

@Injectable()
export class HttpLogMiddleware implements NestMiddleware {
  use(req: Request, res: Response, next: NextFunction) {
    logMiddleware(req, res, next);
  }
}
```

### 2. Register it globally in AppModule

```typescript
// src/app.module.ts
import { Module, NestModule, MiddlewareConsumer } from '@nestjs/common';
import { HttpLogMiddleware } from './http-log.middleware';

@Module({ /* ... */ })
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer
      .apply(HttpLogMiddleware)
      .forRoutes('*'); // or specific controllers / paths
  }
}
```

### 3. Or register globally in main.ts (before routes)

```typescript
// src/main.ts
import { createMiddleware } from 'data-for-logs';

const app = await NestFactory.create(AppModule);
app.use(createMiddleware((_err, payload) => logger.log(payload)));
await app.listen(3000);
```

---

## API

### `createMiddleware(handler, options?)`

Returns a ready-made `(req, res, next) => void` middleware function.  
**This is the recommended entry point for Nest / Express.**

```typescript
const mw = createMiddleware((_err, payload) => {
  kafkaProducer.send({
    topic: 'http-logs',
    messages: [{ value: JSON.stringify(payload) }],
  });
});
```

---

### `onResponseComplete(req, res, handler, options?)`

Low-level hook. Fires `handler` exactly once when the response ends.  
Returns a function you can call to force completion early (`manual` event).

```typescript
const flush = onResponseComplete(req, res, (_err, payload) => {
  console.log(payload);
});
// flush(); // force early if needed
```

---

### `getRequestSnapshot(req, options?)`

Returns the request snapshot immediately (no waiting for response).  
Useful inside route handlers or interceptors.

```typescript
const snap = getRequestSnapshot(req, { includeBody: true });
```

---

### `getResponseSnapshot(res)`

Returns the response snapshot. Call after `res.end()` for complete data.

```typescript
const snap = getResponseSnapshot(res);
```

---

## Options

| Option | Type | Default | Description |
|---|---|---|---|
| `includeBody` | `boolean` | `true` | Include `req.body` in the snapshot |
| `includeRawBody` | `boolean` | `false` | Include `req.rawBody` (if your middleware sets it) |
| `redactSensitiveHeaders` | `boolean` | `true` | Redact `authorization`, `cookie`, `set-cookie`, `x-api-key`, `proxy-authorization` |
| `redactBodyKeys` | `string[]` | `null` | Extra body keys to redact (merged with built-in list) |
| `maxBodyDepth` | `number` | `8` | Max depth when cloning body |
| `maxBodyKeys` | `number` | `200` | Max object keys per level |
| `maxArrayElements` | `number` | `100` | Max array items to include |
| `maxStringLength` | `number` | `10000` | Truncate strings longer than this |
| `highResTime` | `() => number` | `Date.now` | Use `performance.now()` for sub-ms timing |
| `onHandlerError` | `(err) => void` | — | Called if your handler throws |

---

## Built-in redacted body keys

`password`, `passwd`, `secret`, `token`, `access_token`, `refresh_token`,
`authorization`, `credit_card`, `creditcard`, `cvv`, `ssn`

Add more via `redactBodyKeys` option. All comparisons are **case-insensitive**.

---

## event values

| Value | Meaning |
|---|---|
| `finish` | Response sent normally |
| `close` | Client disconnected before response finished |
| `manual` | You called the returned flush function early |

---

## License

ISC
