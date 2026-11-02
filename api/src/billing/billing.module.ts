import { Controller, Get, Header, Module, Query } from '@nestjs/common';
import { KeyInQuery } from '../auth/auth.decorators';
import { BillingService } from './billing.service';

@Controller('billing')
export class BillingController {
  constructor(private readonly billing: BillingService) {}

  /** ?limit= (1..200, default 50) and ?offset= page byTask; totals, byModel and byAgent cover all usage. */
  @Get('summary')
  summary(@Query('limit') limit?: string, @Query('offset') offset?: string) {
    return this.billing.summary(limit === undefined ? 50 : Number(limit), offset === undefined ? 0 : Number(offset));
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
