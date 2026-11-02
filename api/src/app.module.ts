import { Module } from '@nestjs/common';
import { AuthModule } from './auth/auth.module';
import { BillingModule } from './billing/billing.module';
import { EventsModule } from './events/events.module';
import { GatewayModule } from './gateway/gateway.module';
import { HealthController } from './health/health.controller';
import { InfrastructureModule } from './infrastructure.module';
import { MetricsController } from './observability/metrics.controller';
import { OrchestrationModule } from './orchestration/orchestration.module';
import { RetentionService } from './retention/retention.service';

@Module({
  imports: [InfrastructureModule, AuthModule, BillingModule, GatewayModule, EventsModule, OrchestrationModule],
  controllers: [HealthController, MetricsController],
  providers: [RetentionService],
})
export class AppModule {}
