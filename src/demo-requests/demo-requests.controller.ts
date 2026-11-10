import { Body, Controller, Get, HttpCode, Post, Query, Req } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { CurrentUser, Public, RequirePermissions } from '../common/decorators/auth.decorators.js';
import type { AuthUser } from '../common/auth/auth-user.js';
import { PaginationQuery } from '../common/pagination.dto.js';
import { DemoRequestsService } from './demo-requests.service.js';
import { CreateDemoRequestDto } from './dto.js';

@ApiTags('demo-requests')
@Controller('demo-requests')
export class DemoRequestsController {
  constructor(private readonly service: DemoRequestsService) {}

  @Public()
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @Post()
  @HttpCode(201)
  create(@Body() dto: CreateDemoRequestDto, @Req() req: Request) {
    return this.service.create(dto, req.ip);
  }

  @ApiBearerAuth()
  @RequirePermissions('demo_requests.read')
  @Get()
  list(@Query() q: PaginationQuery, @CurrentUser() user: AuthUser) {
    return this.service.list(q, user);
  }
}
