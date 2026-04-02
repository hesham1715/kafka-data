import type { IncomingMessage, ServerResponse } from 'http';

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
 * **Nest `AppModule` example:**
 * ```ts
 * consumer
 *   .apply(createMiddleware((err, payload) => this.logger.log(payload), { includeBody: true }))
 *   .forRoutes('*');
 * ```
 *
 * **`main.ts` global example:**
 * ```ts
 * app.use(createMiddleware((err, payload) => logger.log(payload)));
 * ```
 */
export declare function createMiddleware(
  handler: OnCompleteHandler,
  options?: OnResponseCompleteOptions,
): (req: IncomingMessage, res: ServerResponse, next: () => void) => void;
