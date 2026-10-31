import { Module } from '@nestjs/common';
import { SocietiesController } from './societies.controller';
import { SocietiesService } from './societies.service';
import { CommunityController } from './community.controller';
import { CommunityService } from './community.service';
import { AuthModule } from '../auth/auth.module';

@Module({
  imports: [AuthModule],
  controllers: [SocietiesController, CommunityController],
  providers: [SocietiesService, CommunityService],
  exports: [SocietiesService, CommunityService],
})
export class SocietiesModule {}
