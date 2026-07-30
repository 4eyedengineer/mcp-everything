import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ApiKey } from '../database/entities/api-key.entity';
import { ApiKeyService } from './api-key.service';
import { ApiKeyController } from './api-key.controller';

@Module({
  imports: [TypeOrmModule.forFeature([ApiKey])],
  controllers: [ApiKeyController],
  providers: [ApiKeyService],
  // Exported so JwtAuthGuard (in AppModule and AuthModule) can authenticate
  // requests that present an API key instead of a JWT.
  exports: [ApiKeyService],
})
export class ApiKeyModule {}
