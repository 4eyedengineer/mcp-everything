import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { User } from '../database/entities/user.entity';
import { UsageRecord } from '../database/entities/usage.entity';
import { HostedServer } from '../database/entities/hosted-server.entity';
import { UserService } from './user.service';
import { AccountController } from './account.controller';

@Module({
  // HostedServer is here only so UserService can refuse to delete an account
  // that still owns live hosted servers - see UserService.deleteUser and the
  // ON DELETE RESTRICT foreign key added in
  // 1754100000002-AddHostedServerUserForeignKey.ts. Deliberately a repository
  // rather than an import of HostingModule: this is a read-only pre-flight
  // check, and UserModule must not gain a dependency on the whole hosting
  // stack (HostingModule already sits downstream of auth/user concerns).
  imports: [TypeOrmModule.forFeature([User, UsageRecord, HostedServer])],
  controllers: [AccountController],
  providers: [UserService],
  exports: [UserService],
})
export class UserModule {}
