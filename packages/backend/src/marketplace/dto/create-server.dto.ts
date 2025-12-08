import {
  IsString,
  IsOptional,
  IsArray,
  IsEnum,
  IsUrl,
  MaxLength,
  MinLength,
  ArrayMaxSize,
  IsUUID,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import {
  McpServerCategory,
  McpServerVisibility,
  McpServerLanguage,
  VALID_CATEGORIES,
  MCP_SERVER_VISIBILITIES,
  MCP_SERVER_LANGUAGES,
} from '../types/categories';

class McpToolDto {
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  name: string;

  @IsString()
  @MaxLength(500)
  description: string;

  @IsOptional()
  inputSchema?: Record<string, unknown>;
}

class McpResourceDto {
  @IsString()
  @MinLength(1)
  uri: string;

  @IsString()
  @MinLength(1)
  @MaxLength(100)
  name: string;

  @IsString()
  @MaxLength(500)
  description: string;
}

export class CreateServerDto {
  @IsString()
  @MinLength(2)
  @MaxLength(100)
  name: string;

  @IsString()
  @MinLength(10)
  @MaxLength(500)
  description: string;

  @IsOptional()
  @IsString()
  @MaxLength(5000)
  longDescription?: string;

  @IsString()
  category: McpServerCategory;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  @ArrayMaxSize(10)
  tags?: string[];

  @IsOptional()
  @IsEnum(MCP_SERVER_VISIBILITIES)
  visibility?: McpServerVisibility;

  @IsOptional()
  @IsUrl()
  @MaxLength(500)
  repositoryUrl?: string;

  @IsOptional()
  @IsUrl()
  @MaxLength(500)
  gistUrl?: string;

  @IsOptional()
  @IsUrl()
  @MaxLength(500)
  downloadUrl?: string;

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => McpToolDto)
  tools?: McpToolDto[];

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => McpResourceDto)
  resources?: McpResourceDto[];

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  @ArrayMaxSize(20)
  envVars?: string[];

  @IsOptional()
  @IsEnum(MCP_SERVER_LANGUAGES)
  language?: McpServerLanguage;

  @IsOptional()
  @IsUUID()
  sourceConversationId?: string;

  @IsOptional()
  metadata?: Record<string, unknown>;
}
