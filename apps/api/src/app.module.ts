import 'reflect-metadata';
import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { PrismaModule } from './common/prisma.module';
import { AuthModule } from './auth/auth.module';
import { SocietiesModule } from './societies/societies.module';
import { VisitorsModule } from './visitors/visitors.module';
import { DevicesModule } from './devices/devices.module';
import { AccessModule } from './access/access.module';
import { NotificationsModule } from './notifications/notifications.module';
import { HealthController } from './health.controller';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    PrismaModule,
    AuthModule,
    SocietiesModule,
    VisitorsModule,
    DevicesModule,
    AccessModule,
    NotificationsModule,
  ],
  controllers: [HealthController],
})
export class AppModule {}
