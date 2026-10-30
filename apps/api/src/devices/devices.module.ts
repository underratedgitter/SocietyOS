import { Module } from '@nestjs/common';
import { DevicesController } from './devices.controller';
import { DeviceApiController } from './device-api.controller';
import { DevicesService } from './devices.service';
import { MqttService } from './mqtt.service';
import { DeviceAuthGuard } from './device-auth.guard';
import { AuthModule } from '../auth/auth.module';

@Module({
  imports: [AuthModule],
  controllers: [DevicesController, DeviceApiController],
  providers: [DevicesService, MqttService, DeviceAuthGuard],
  exports: [MqttService],
})
export class DevicesModule {}
