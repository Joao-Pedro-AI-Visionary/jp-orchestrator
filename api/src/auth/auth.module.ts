import { Global, Module } from '@nestjs/common';
import { APP_GUARD, Reflector } from '@nestjs/core';
import { authConfig } from './auth.config';
import { ApiKeyGuard, AUTH_CONFIG } from './auth.guard';
import { RateLimitGuard } from './rate-limit.guard';

/** API key auth with roles, then the rate limit (APP_GUARDs run in this order). */
@Global()
@Module({
  providers: [
    { provide: AUTH_CONFIG, useFactory: () => authConfig() },
    { provide: APP_GUARD, inject: [Reflector, AUTH_CONFIG], useFactory: (r: Reflector, c: ReturnType<typeof authConfig>) => new ApiKeyGuard(r, c) },
    { provide: APP_GUARD, useClass: RateLimitGuard },
  ],
  exports: [AUTH_CONFIG],
})
export class AuthModule {}
