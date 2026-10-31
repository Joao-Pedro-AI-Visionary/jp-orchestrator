import { Module } from '@nestjs/common';
import { BillingModule } from './billing/billing.module';
import { EventsModule } from './events/events.module';
import { GatewayModule } from './gateway/gateway.module';
import { HealthController } from './health/health.controller';
import { InfrastructureModule } from './infrastructure.module';
import { OrchestrationModule } from './orchestration/orchestration.module';

@Module({
  imports: [InfrastructureModule, BillingModule, GatewayModule, EventsModule, OrchestrationModule],
  controllers: [HealthController],
})
export class AppModule {}
