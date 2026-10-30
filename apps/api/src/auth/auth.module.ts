import { Module } from '@nestjs/common';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { JwtAuthGuard } from './jwt-auth.guard';
import { SocietyScopeGuard } from './society-scope.guard';
import { FlatScopeGuard } from './flat-scope.guard';

@Module({
  controllers: [AuthController],
  providers: [AuthService, JwtAuthGuard, SocietyScopeGuard, FlatScopeGuard],
  exports: [AuthService, JwtAuthGuard, SocietyScopeGuard, FlatScopeGuard],
})
export class AuthModule {}
