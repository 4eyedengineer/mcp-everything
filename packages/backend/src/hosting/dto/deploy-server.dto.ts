import { IsString, IsOptional, MaxLength } from 'class-validator';

export class DeployServerDto {
  @IsOptional()
  @IsString()
  @MaxLength(100)
  serverName?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string;
}
