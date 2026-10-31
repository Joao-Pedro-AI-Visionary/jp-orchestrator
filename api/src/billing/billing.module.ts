import { Controller, Get, Header, Module } from '@nestjs/common';
import { BillingService } from './billing.service';

@Controller('billing')
export class BillingController {
  constructor(private readonly billing: BillingService) {}

  @Get('summary')
  summary() {
    return this.billing.summary();
  }

  @Get('report.csv')
  @Header('content-type', 'text/csv; charset=utf-8')
  @Header('content-disposition', 'attachment; filename="jp-orchestrator-billing.csv"')
  csv() {
    return this.billing.csv();
  }
}

@Module({ controllers: [BillingController], providers: [BillingService], exports: [BillingService] })
export class BillingModule {}
