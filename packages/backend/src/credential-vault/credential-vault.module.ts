import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { UserCredential } from '../database/entities/user-credential.entity';
import { TokenEncryptionModule } from '../common/token-encryption/token-encryption.module';
import { CredentialVaultService } from './credential-vault.service';
import { CredentialVaultController } from './credential-vault.controller';

@Module({
  imports: [TypeOrmModule.forFeature([UserCredential]), TokenEncryptionModule],
  controllers: [CredentialVaultController],
  providers: [CredentialVaultService],
  // Exported so the deployment/hosting injection layer can call
  // `resolveForDeploy` to turn ENV_VAR_NAME -> credential name refs into
  // decrypted values at deploy time.
  exports: [CredentialVaultService],
})
export class CredentialVaultModule {}
