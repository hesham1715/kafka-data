import type { IncomingMessage, ServerResponse } from 'http';

// ─── Transport interface ──────────────────────────────────────────────────────

/**
 * The contract every transport must implement.
 * `send` is the only required method; `connect` and `disconnect` are optional
 * lifecycle hooks (called automatically by built-in transports).
 */
export interface Transport {
  /** Publish a log payload to the underlying system. */
  send(payload: unknown): Promise<void>;
  /** Optional: open/establish the connection. */
  connect?(): Promise<void>;
  /** Optional: gracefully close the connection. */
  disconnect?(): Promise<void>;
}

// ─── Kafka transport ─────────────────────────────────────────────────────────

export interface KafkaTransportConfig {
  /** List of broker addresses, e.g. ['localhost:9092'] */
  brokers: string[];
  /** Kafka topic to publish log payloads to. */
  topic: string;
  /** Kafka client id (default: 'http-log-transport') */
  clientId?: string;
  /** kafkajs SSL options */
  ssl?: object;
  /** kafkajs SASL options */
  sasl?: object;
  /** Extra kafkajs producer options */
  producerConfig?: object;
  /** Custom serializer function. Default: JSON.stringify */
  serialize?: (payload: unknown) => string;
  /** Static Kafka message key */
  messageKey?: string;
  /**
   * Dynamic key function — takes precedence over messageKey.
   * If omitted, transport falls back to payload requestId.
   */
  getKey?: (payload: unknown) => string;
  /** Wrap outbound message as `{ eventType, publishedAt, payload }`. Default: true */
  wrapPayload?: boolean;
  /** Envelope event type. Default: `topic` */
  eventType?: string;
  /**
   * Compute envelope publish time. Receives original payload.
   * Default: `payload.timestamp` (if present) or current time.
   */
  getPublishedAt?: (payload: unknown) => string;

  // ── Partition / auto-scaling ─────────────────────────────────────────────

  /**
   * Static partition number. Overrides key-based (murmur2) routing.
   * Takes effect only when `getPartition` is not provided.
   */
  partition?: number;
  /**
   * Dynamic partition function. Called with the final outbound payload and must
   * return a partition index. Takes precedence over `partition`.
   *
   * @example
   * // Route by HTTP method so each method lands on a dedicated partition
   * getPartition: (payload) => {
   *   const map: Record<string, number> = { GET: 0, POST: 1, PUT: 2, PATCH: 2, DELETE: 3 };
   *   return map[(payload as any)?.payload?.apiMethod ?? 'GET'] ?? 0;
   * }
   */
  getPartition?: (payload: unknown) => number;
  /**
   * When `true`, the transport creates the topic on first connect if it does
   * not already exist, using `numPartitions` and `replicationFactor`.
   * Default: `false`.
   */
  autoCreateTopic?: boolean;
  /**
   * Number of partitions to create when `autoCreateTopic` is `true`.
   * Has no effect if the topic already exists.
   * Default: `1`.
   */
  numPartitions?: number;
  /**
   * Replication factor to use when `autoCreateTopic` is `true`.
   * Should be ≤ the number of brokers in your cluster.
   * Default: `1`.
   */
  replicationFactor?: number;
  /**
   * How often (in milliseconds) the producer refreshes partition-count metadata
   * from the broker. A lower value (e.g. `30_000`) lets the producer detect
   * externally-added partitions faster; a higher value reduces broker load.
   * Default: `300_000` (5 minutes).
   */
  metadataMaxAge?: number;
}

/**
 * Creates a Kafka transport.
 * Requires `kafkajs` to be installed: npm install kafkajs
 *
 * @example
 * const transport = createKafkaTransport({
 *   brokers: ['localhost:9092'],
 *   topic: 'http-logs',
 * });
 * app.use(createMiddleware(transport, { includeBody: true }));
 */
export declare function createKafkaTransport(config: KafkaTransportConfig): Transport;

export interface LogOptions {
  redactSensitiveHeaders?: boolean;
  /** Extra body keys (case-insensitive) to redact; merged with built-in secrets list */
  redactBodyKeys?: string[];
  maxBodyDepth?: number;
  maxBodyKeys?: number;
  maxArrayElements?: number;
  maxStringLength?: number;
  includeBody?: boolean;
  /** If you use raw-body middleware and attach `req.rawBody` */
  includeRawBody?: boolean;
}

export interface HttpRequestSnapshot {
  method?: string;
  httpVersion?: string;
  url?: string;
  originalUrl?: string;
  baseUrl?: string;
  path?: string;
  route?: string;
  query?: Record<string, unknown>;
  params?: Record<string, unknown>;
  headers: Record<string, string | string[] | undefined>;
  remoteAddress?: string;
  remotePort?: number;
  localAddress?: string;
  localPort?: number;
  forwardedFor?: string;
  forwardedProto?: string;
  forwardedHost?: string;
  realIp?: string;
  ip?: string;
  ips?: string[];
  hostname?: string;
  protocol?: string;
  secure?: boolean;
  requestId?: string;
  contentType?: string;
  contentLength?: string;
  userAgent?: string;
  accept?: string;
  referer?: string;
  body?: unknown;
  rawBody?: string;
}

export interface HttpResponseSnapshot {
  statusCode?: number;
  statusMessage?: string;
  headers: Record<string, string | string[] | undefined>;
  headersSent?: boolean;
  finished?: boolean;
  writableEnded?: boolean;
  /** Populated when `captureResponseBody: true` is set in options */
  body?: unknown;
}

export interface HttpLogPayload {
  /** ISO-8601 wall-clock timestamp of when the request arrived */
  timestamp: string;
  event: 'finish' | 'close' | 'manual';
  durationMs: number;
  request: HttpRequestSnapshot;
  response: HttpResponseSnapshot;
}

/**
 * Default nested payload with `userId` and `userRole` merged at the top level
 * when `transform` is omitted and `outputFormat` is `'nested'` (the default).
 */
export type HttpNestedLogPayload = HttpLogPayload & {
  userId: unknown;
  userRole: unknown;
};

/**
 * Built-in flat log record when `outputFormat: 'flat'` and `transform` is omitted.
 * Set `captureResponseBody: true` to populate `responseBody`.
 */
export interface HttpFlatLogPayload {
  requestId: unknown;
  appName: unknown;
  appVersion: unknown;
  buildNumber: unknown;
  platform: unknown;
  apiRoute: unknown;
  apiMethod: unknown;
  userIp: unknown;
  requestBody: unknown;
  responseBody: unknown;
  service: unknown;
  responseStatus: unknown;
  responseStatusCode: unknown;
  responseTime: number;
  userId: unknown;
  userRole: unknown;
  userDevice: string;
  userBrowser: string;
}

export type OnCompleteHandler = (
  err: null,
  payload: HttpLogPayload | HttpNestedLogPayload | HttpFlatLogPayload,
) => void;

export interface UserAgentInfo {
  device:  string;
  browser: string;
  os:      string;
}

/**
 * Parses a User-Agent string into device, browser, and OS.
 * Best-effort heuristics — replace with `ua-parser-js` for production accuracy.
 */
export declare function parseUserAgent(ua?: string): UserAgentInfo;

/** Context passed as the second argument to the `transform` function. */
export interface TransformContext {
  /**
   * Resolved user id.
   * Source priority: `getUserId` option → `req.user.id` → `null`
   */
  userId: unknown;
  /**
   * Resolved user role.
   * Source priority: `getUserRole` option → `req.user.role` → `null`
   */
  userRole: unknown;
  /** The raw Node.js / Express `Request` object (has `req.user`, etc.) */
  req: IncomingMessage & { user?: { id?: unknown; role?: unknown; [key: string]: unknown } };
  /** The raw Node.js / Express `Response` object */
  res: ServerResponse;
}

export interface OnResponseCompleteOptions extends LogOptions {
  /** Use `() => performance.now()` in Node for sub-ms timing */
  highResTime?: () => number;
  onHandlerError?: (err: unknown) => void;
  /**
   * When true, patches `res.write` / `res.end` to collect the response body
   * and attach it as `response.body` in the payload.
   */
  captureResponseBody?: boolean;
  /**
   * Maximum response body size (in bytes) that can be captured when
   * `captureResponseBody` is enabled. If exceeded, `response.body` is omitted.
   * Default: 1 MB.
   *
   * Can be overridden per request by setting:
   * `req.logOptions.maxResponseBodyBytes = <number>`
   * (useful with Nest decorators/interceptors for route-specific limits).
   */
  maxResponseBodyBytes?: number;
  /**
   * Resolve the user id to include in the log.
   *
   * - Pass a **function** `(req) => req.user?.id` to derive it from the request.
   * - Pass a **static value** to always use that value.
   * - Omit entirely to fall back to `req.user?.id` automatically.
   * - Falls back to `null` if nothing is found.
   */
  getUserId?: ((req: IncomingMessage & Record<string, any>) => unknown) | unknown;
  /**
   * Resolve the user role to include in the log.
   *
   * - Pass a **function** `(req) => req.user?.role` to derive it from the request.
   * - Pass a **static value** to always use that value.
   * - Omit entirely to fall back to `req.user?.role` automatically.
   * - Falls back to `null` if nothing is found.
   */
  getUserRole?: ((req: IncomingMessage & Record<string, any>) => unknown) | unknown;
  /**
   * How to shape the payload before `transport.send()` when `transform` is omitted.
   * - `'nested'` (default): `{ ...HttpLogPayload, userId, userRole }`
   * - `'flat'`: built-in flat record (`HttpFlatLogPayload`) with app headers, route, bodies, timing, UA
   */
  outputFormat?: 'nested' | 'flat';
  /**
   * When `outputFormat` is `'flat'`, overrides `process.env.SERVICE_NAME` for the `service` field.
   * Default: `process.env.SERVICE_NAME` or `'APTS'`.
   */
  serviceName?: string;
  /**
   * Transform the raw `HttpLogPayload` into any custom shape before it is
   * passed to `transport.send()`.
   *
   * The second argument `context` provides the resolved `userId`, `userRole`,
   * and the raw `req` / `res` objects for anything not in the snapshot.
   *
   * @example
   * transform: (payload, { userId, userRole }) => ({
   *   appName:     payload.request.headers['x-app-name'],
   *   apiRoute:    payload.request.url,
   *   responseTime: Math.round(payload.durationMs),
   *   userId,
   *   userRole,
   * })
   */
  transform?: (payload: HttpLogPayload, context: TransformContext) => unknown;
}

export declare const DEFAULT_OPTIONS: Readonly<{
  redactSensitiveHeaders: boolean;
  redactBodyKeys: null;
  maxBodyDepth: number;
  maxBodyKeys: number;
  maxArrayElements: number;
  maxStringLength: number;
  includeBody: boolean;
  includeRawBody: boolean;
  maxResponseBodyBytes: number;
}>;

export declare const SENSITIVE_HEADER_NAMES: ReadonlySet<string>;

export declare function pickHeaders(
  headers: IncomingMessage['headers'] | Record<string, unknown>,
  options?: Pick<LogOptions, 'redactSensitiveHeaders'>,
): Record<string, string | string[] | undefined>;

export declare function sanitizeBody(body: unknown, options?: LogOptions): unknown;

export declare function getRequestSnapshot(
  req: IncomingMessage,
  options?: LogOptions,
): HttpRequestSnapshot;

export declare function getResponseSnapshot(
  res: ServerResponse,
): HttpResponseSnapshot;

/**
 * Runs `handler` once when the response ends (normal finish or client disconnect).
 * Request snapshot is taken at call time (body usually already parsed by Nest body parser).
 */
export declare function onResponseComplete(
  req: IncomingMessage,
  res: ServerResponse,
  handler: OnCompleteHandler,
  options?: OnResponseCompleteOptions,
): () => void;

/**
 * Returns a ready-made Express/Nest middleware `(req, res, next) => void`.
 *
 * Accepts three forms:
 *
 * **1. Callback handler (original API):**
 * ```ts
 * app.use(createMiddleware((err, payload) => logger.log(payload)));
 * ```
 *
 * **2. A single transport:**
 * ```ts
 * const transport = createKafkaTransport({ brokers: ['localhost:9092'], topic: 'http-logs' });
 * app.use(createMiddleware(transport, { includeBody: true }));
 * ```
 *
 * **3. Multiple transports (fan-out):**
 * ```ts
 * app.use(createMiddleware([kafkaTransport, webhookTransport], { includeBody: true }));
 * ```
 *
 * **Nest `AppModule` example:**
 * ```ts
 * consumer
 *   .apply(createMiddleware(transport, { includeBody: true }))
 *   .forRoutes('*');
 * ```
 */
export declare function createMiddleware(
  transportOrHandler: OnCompleteHandler | Transport | Transport[],
  options?: OnResponseCompleteOptions,
): (req: IncomingMessage, res: ServerResponse, next: () => void) => void;
