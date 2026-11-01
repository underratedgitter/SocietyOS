import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { VisitorsModule } from '../visitors/visitors.module';
import { RelativesController } from './relatives.controller';
import { RelativesService } from './relatives.service';

@Module({
  imports: [AuthModule, VisitorsModule],
  controllers: [RelativesController],
  providers: [RelativesService],
  exports: [RelativesService],
})
export class RelativesModule {}
