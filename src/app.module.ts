import { Module } from '@nestjs/common';

import { PrismaModule } from './prisma/prisma.module';
import { AuthModule } from './auth/auth.module';
import {
  TimeTrackingController,
  ApprovalsController,
} from './time-tracking/time-tracking.controller';
import { ActivityTypesController } from './time-tracking/activity-types.controller';
import { ActivityAssignmentsController } from './time-tracking/activity-assignments.controller';
import { TimeTrackingService } from './time-tracking/time-tracking.service';
import {
  BreakEnforcementService,
  EnforcementWorker,
} from './time-tracking/break-enforcement.service';
import {
  TimeTrackingGateway,
  TimeEventsPublisher,
} from './time-tracking/time-tracking.gateway';
import { LeaveController } from './leave/leave.controller';
import { SchedulesController } from './scheduling/schedules.controller';
import { OversightController } from './oversight/oversight.controller';
import { UsersController } from './admin/users.controller';
import { TeamsController } from './admin/teams.controller';
import { ProfileController } from './profile/profile.controller';
import { PayrollController } from './payroll/payroll.controller';
import { IdleController } from './idle/idle.controller';

@Module({
  imports: [
    PrismaModule, // @Global → PrismaService available everywhere
    AuthModule,   // exports JwtModule + guards used by the controllers/gateway
  ],
  controllers: [TimeTrackingController, ApprovalsController, ActivityTypesController, ActivityAssignmentsController, LeaveController, SchedulesController, OversightController, UsersController, TeamsController, ProfileController, PayrollController, IdleController],
  providers: [
    TimeTrackingService,
    BreakEnforcementService,
    EnforcementWorker, // deadline jobs + 30s sweep (same process in dev)
    TimeTrackingGateway,
    TimeEventsPublisher,
  ],
})
export class AppModule {}
