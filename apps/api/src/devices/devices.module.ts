import { Module } from '@nestjs/common';
import { DevicesController } from './devices.controller';
import { DeviceApiController } from './device-api.controller';
import { DevicesService } from './devices.service';
import { MqttService } from './mqtt.service';
import { DeviceAuthGuard } from './device-auth.guard';
import { AuthModule } from '../auth/auth.module';
import { GateAdapterFactory } from './adapters/gate-adapter.factory';
import { BiometricsService } from './biometrics.service';
import { BiometricIdentityService } from './vendor/biometric-identity.service';
import { BiometricIngestService } from './vendor/biometric-ingest.service';
import { DeviceSyncService } from './vendor/device-sync.service';
import { BiometricIdentityController, VendorDeviceApiController } from './vendor/vendor-device.controller';
import { ZktecoAdmsController } from './vendor/zkteco/zkteco-adms.controller';
import { VendorPushController } from './vendor/vendor-push.controller';
import { PushDeviceGuard } from './vendor/push-device.guard';

@Module({
  imports: [AuthModule],
  controllers: [
    DevicesController,
    DeviceApiController,
    VendorDeviceApiController,
    VendorPushController,
    BiometricIdentityController,
    ZktecoAdmsController,
  ],
  providers: [
    DevicesService,
    MqttService,
    DeviceAuthGuard,
    PushDeviceGuard,
    GateAdapterFactory,
    BiometricsService,
    BiometricIdentityService,
    BiometricIngestService,
    DeviceSyncService,
  ],
  exports: [MqttService, GateAdapterFactory, BiometricsService, BiometricIngestService, DeviceSyncService],
})
export class DevicesModule {}

