import { Controller, Get, Header, Module } from '@nestjs/common';
import { KeyInQuery } from '../auth/auth.decorators';
import { BillingService } from './billing.service';

@Controller('billing')
export class BillingController {
  constructor(private readonly billing: BillingService) {}

  @Get('summary')
  summary() {
    return this.billing.summary();
  }

  /** Download link: the key may come as ?api_key= or the jp_api_key cookie. */
  @Get('report.csv')
  @KeyInQuery()
  @Header('content-type', 'text/csv; charset=utf-8')
  @Header('content-disposition', 'attachment; filename="jp-orchestrator-billing.csv"')
  csv() {
    return this.billing.csv();
  }
}

@Module({ controllers: [BillingController], providers: [BillingService], exports: [BillingService] })
export class BillingModule {}
