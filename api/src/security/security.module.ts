import { Global, Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { securityConfig } from './security.config';
import { ApiKeyGuard, RateLimitGuard, SECURITY_CONFIG } from './security.guards';

/** Global guards, in order: rate limit, then API key. */
@Global()
@Module({
  providers: [
    { provide: SECURITY_CONFIG, useFactory: () => securityConfig() },
    { provide: APP_GUARD, useClass: RateLimitGuard },
    { provide: APP_GUARD, useClass: ApiKeyGuard },
  ],
  exports: [SECURITY_CONFIG],
})
export class SecurityModule {}
