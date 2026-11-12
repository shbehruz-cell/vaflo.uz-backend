import { Module } from '@nestjs/common';
import { AuthController } from './auth.controller.js';
import { AuthService } from './auth.service.js';
import { GeoService } from './geo.service.js';
import { LoginThrottleService } from './login-throttle.service.js';

@Module({
  controllers: [AuthController],
  providers: [AuthService, GeoService, LoginThrottleService],
  exports: [AuthService],
})
export class AuthModule {}
