import { Global, Module } from '@nestjs/common';
import { PrismaService } from './prisma.service';
import { AuditService } from './audit.service';
import { RateLimitService } from './rate-limit.service';

@Global()
@Module({
  providers: [PrismaService, AuditService, RateLimitService],
  exports: [PrismaService, AuditService, RateLimitService],
})
export class PrismaModule {}
