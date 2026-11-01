import { Module } from '@nestjs/common';
import { NotificationsService } from './notifications.service';
import { SmsDispatcherService } from './sms-dispatcher.service';
import { WhatsappDispatcherService } from './whatsapp-dispatcher.service';
import { PushDispatcherService } from './push-dispatcher.service';
import { PushTokenController } from './push-token.controller';

@Module({
  controllers: [PushTokenController],
  providers: [
    NotificationsService,
    SmsDispatcherService,
    WhatsappDispatcherService,
    PushDispatcherService,
  ],
  exports: [
    NotificationsService,
    SmsDispatcherService,
    WhatsappDispatcherService,
    PushDispatcherService,
  ],
})
export class NotificationsModule {}
