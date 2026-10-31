import { Global, Module } from '@nestjs/common';
import { PrismaService } from './prisma.service';
import { AuditService } from './audit.service';
import { RateLimitService } from './rate-limit.service';
import { AuthzService } from './authz.service';
import { MaintenanceService } from './maintenance.service';

@Global()
@Module({
  providers: [PrismaService, AuditService, RateLimitService, AuthzService, MaintenanceService],
  exports: [PrismaService, AuditService, RateLimitService, AuthzService, MaintenanceService],
})
export class PrismaModule {}
