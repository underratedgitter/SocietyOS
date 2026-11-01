import { Module } from '@nestjs/common';
import { VisitorPassesController } from './visitor-passes.controller';
import { VisitorPassesService } from './visitor-passes.service';
import { CredentialsService } from './credentials.service';
import { IdempotencyService } from './idempotency.service';
import { AuthModule } from '../auth/auth.module';
import { NotificationsModule } from '../notifications/notifications.module';

@Module({
  imports: [AuthModule, NotificationsModule],
  controllers: [VisitorPassesController],
  providers: [VisitorPassesService, CredentialsService, IdempotencyService],
  exports: [VisitorPassesService, CredentialsService, IdempotencyService],
})
export class VisitorsModule {}
