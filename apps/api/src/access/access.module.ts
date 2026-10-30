import { Module } from '@nestjs/common';
import { AccessController } from './access.controller';
import { AccessEngineService } from './access-engine.service';
import { AuthModule } from '../auth/auth.module';
import { DevicesModule } from '../devices/devices.module';
import { VisitorsModule } from '../visitors/visitors.module';
import { NotificationsModule } from '../notifications/notifications.module';

@Module({
  imports: [AuthModule, DevicesModule, VisitorsModule, NotificationsModule],
  controllers: [AccessController],
  providers: [AccessEngineService],
})
export class AccessModule {}
