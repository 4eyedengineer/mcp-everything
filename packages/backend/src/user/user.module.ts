import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { User } from '../database/entities/user.entity';
import { UsageRecord } from '../database/entities/usage.entity';
import { UserService } from './user.service';
import { AccountController } from './account.controller';

@Module({
  imports: [
    TypeOrmModule.forFeature([User, UsageRecord]),
  ],
  controllers: [AccountController],
  providers: [UserService],
  exports: [UserService],
})
export class UserModule {}
