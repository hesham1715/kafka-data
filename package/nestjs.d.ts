import type { NestInterceptor, ExecutionContext, CallHandler } from '@nestjs/common';
import type { Reflector } from '@nestjs/core';
import type { Observable } from 'rxjs';

export declare const MAX_RESPONSE_BODY_MB: string;

/**
 * Route-level decorator that limits the response body size captured for logging.
 *
 * Apply above any controller method. Requires {@link MaxResponseBodyInterceptor}
 * to be registered globally in your `AppModule`.
 *
 * @param mb - Max response body in megabytes (e.g. `0.1` for 100 KB, `0` to suppress entirely)
 *
 * @example
 * ```ts
 * \@Get()
 * \@MaxResponseBodyMB(0.1)
 * findAll() { ... }
 * ```
 */
export declare function MaxResponseBodyMB(mb: number): MethodDecorator & ClassDecorator;

/**
 * NestJS interceptor that reads `@MaxResponseBodyMB()` metadata and sets
 * `req.logOptions.maxResponseBodyBytes` so the `data-for-logs` middleware
 * respects per-route response body size limits.
 *
 * Register **once** globally in your `AppModule`:
 *
 * ```ts
 * import { APP_INTERCEPTOR } from '@nestjs/core';
 * import { MaxResponseBodyInterceptor } from 'data-for-logs/nestjs';
 *
 * @Module({
 *   providers: [
 *     { provide: APP_INTERCEPTOR, useClass: MaxResponseBodyInterceptor },
 *   ],
 * })
 * export class AppModule {}
 * ```
 *
 * Then use `@MaxResponseBodyMB()` on any route — no per-project boilerplate needed.
 */
export declare class MaxResponseBodyInterceptor implements NestInterceptor {
  constructor(reflector: Reflector);
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown>;
}
