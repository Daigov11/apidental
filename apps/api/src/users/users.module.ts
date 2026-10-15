import { Module } from '@nestjs/common';
import { AssignmentsService } from './assignments.service.js';
import { LastAuthorityService } from './last-authority.service.js';
import { UsersController } from './users.controller.js';
import { UsersService } from './users.service.js';

@Module({
  controllers: [UsersController],
  providers: [UsersService, AssignmentsService, LastAuthorityService],
  exports: [AssignmentsService, LastAuthorityService],
})
export class UsersModule {}
