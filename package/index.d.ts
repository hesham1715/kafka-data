import type { IncomingMessage, ServerResponse } from 'http';

// ─── Transport interface ──────────────────────────────────────────────────────

/**
 * The contract every transport must implement.
 * `send` is the only required method; `connect` and `disconnect` are optional
 * lifecycle hooks (called automatically by built-in transports).
 */
export interface Transport {
  /** Publish a log payload to the underlying system. */
  send(payload: HttpLogPayload): Promise<void>;
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
  serialize?: (payload: HttpLogPayload) => string;
  /** Static Kafka message key */
  messageKey?: string;
  /** Dynamic key function — takes precedence over messageKey */
  getKey?: (payload: HttpLogPayload) => string;
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
}

export interface HttpLogPayload {
  /** ISO-8601 wall-clock timestamp of when the request arrived */
  timestamp: string;
  event: 'finish' | 'close' | 'manual';
  durationMs: number;
  request: HttpRequestSnapshot;
  response: HttpResponseSnapshot;
}

export type OnCompleteHandler = (
  err: null,
  payload: HttpLogPayload,
) => void;

export interface OnResponseCompleteOptions extends LogOptions {
  /** Use `() => performance.now()` in Node for sub-ms timing */
  highResTime?: () => number;
  onHandlerError?: (err: unknown) => void;
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
