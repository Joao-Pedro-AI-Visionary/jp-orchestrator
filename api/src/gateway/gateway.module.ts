import { Controller, Get, Module, NotFoundException, Param, Post } from '@nestjs/common';
import { RateLimited, RequireRole } from '../auth/auth.decorators';
import { PROVIDER_REGISTRY } from '../common/tokens';
import { BillingModule } from '../billing/billing.module';
import { StrategyRegistry } from '../strategy/strategy-registry';
import { GatewayService } from './gateway.service';
import { MockProvider } from './llm-provider';
import { ModelCatalog } from './model-catalog';

@Controller('gateway')
export class GatewayController {
  constructor(private readonly catalog: ModelCatalog, private readonly gateway: GatewayService) {}

  @Get('models')
  models() {
    return this.catalog.list();
  }

  /** Simulates a provider outage (or recovery) so the fallback chain can be observed live. */
  @Post('models/:id/toggle')
  @RequireRole('admin')
  @RateLimited()
  toggle(@Param('id') id: string) {
    const model = this.catalog.get(id);
    if (!model) throw new NotFoundException(`Modelo ${id} não existe`);
    return this.catalog.setHealthy(id, !model.healthy);
  }

  @Get('stats')
  stats() {
    return this.gateway.snapshotStats();
  }
}

@Module({
  imports: [BillingModule],
  controllers: [GatewayController],
  providers: [
    { provide: ModelCatalog, useFactory: () => new ModelCatalog() },
    { provide: PROVIDER_REGISTRY, useFactory: () => new StrategyRegistry('provider', [new MockProvider()]) },
    GatewayService,
  ],
  exports: [GatewayService, ModelCatalog],
})
export class GatewayModule {}
