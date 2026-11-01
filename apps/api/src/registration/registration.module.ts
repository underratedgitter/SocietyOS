import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { VisitorsModule } from '../visitors/visitors.module';
import { RegistrationController } from './registration.controller';
import { RegistrationService } from './registration.service';

@Module({
  imports: [AuthModule, VisitorsModule],
  controllers: [RegistrationController],
  providers: [RegistrationService],
  exports: [RegistrationService],
})
export class RegistrationModule {}
