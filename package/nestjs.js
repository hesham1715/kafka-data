'use strict';

const MAX_RESPONSE_BODY_MB = 'maxResponseBodyMB';

function requirePkg(pkg) {
  try {
    return require(pkg);
  } catch {
    throw new Error(
      `data-for-logs/nestjs requires "${pkg}" to be installed.\n` +
      `Run: npm install @nestjs/common @nestjs/core`,
    );
  }
}

/**
 * Route-level decorator that limits the response body size captured for logging.
 *
 * Apply above any controller method. Requires {@link MaxResponseBodyInterceptor}
 * to be registered globally in your AppModule.
 *
 * @param {number} mb - Max response body in megabytes (e.g. 0.1 for 100 KB)
 *
 * @example
 * \@Get()
 * \@MaxResponseBodyMB(0.1)
 * findAll() { ... }
 */
function MaxResponseBodyMB(mb) {
  const { SetMetadata } = requirePkg('@nestjs/common');
  return SetMetadata(MAX_RESPONSE_BODY_MB, mb);
}

/**
 * NestJS interceptor that reads \@MaxResponseBodyMB() metadata and sets
 * `req.logOptions.maxResponseBodyBytes` so the `data-for-logs` middleware
 * respects per-route response body size limits.
 *
 * Register once globally in AppModule:
 *
 * @example
 * import { APP_INTERCEPTOR } from '\@nestjs/core';
 * import { MaxResponseBodyInterceptor } from 'data-for-logs/nestjs';
 *
 * \@Module({
 *   providers: [
 *     { provide: APP_INTERCEPTOR, useClass: MaxResponseBodyInterceptor },
 *   ],
 * })
 * export class AppModule {}
 */
class MaxResponseBodyInterceptor {
  constructor(reflector) {
    this.reflector = reflector;
  }

  intercept(context, next) {
    const mb = this.reflector.getAllAndOverride(MAX_RESPONSE_BODY_MB, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (typeof mb === 'number' && Number.isFinite(mb) && mb >= 0) {
      const req = context.switchToHttp().getRequest();
      req.logOptions = req.logOptions || {};
      req.logOptions.maxResponseBodyBytes = Math.floor(mb * 1024 * 1024);
    }

    return next.handle();
  }
}

// Apply @Injectable() and register Reflector as the constructor param type
// so NestJS DI wires it automatically when the class is used as APP_INTERCEPTOR.
try {
  const { Injectable } = require('@nestjs/common');
  const { Reflector } = require('@nestjs/core');
  Injectable()(MaxResponseBodyInterceptor);
  if (typeof Reflect !== 'undefined' && typeof Reflect.defineMetadata === 'function') {
    Reflect.defineMetadata('design:paramtypes', [Reflector], MaxResponseBodyInterceptor);
  }
} catch {
  // @nestjs packages not installed — a helpful error is thrown when the
  // decorator / interceptor is actually used at runtime.
}

module.exports = {
  MAX_RESPONSE_BODY_MB,
  MaxResponseBodyMB,
  MaxResponseBodyInterceptor,
};
