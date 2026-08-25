import { IsInt, IsOptional, IsString, Matches, Max, Min, MinLength } from 'class-validator';
import { Type } from 'class-transformer';

/** Matches a valid GitHub owner or repo name segment (letters, digits, `-`, `_`, `.`). */
const GITHUB_NAME_SEGMENT = /^[\w.-]+$/;

/**
 * Query DTO for GET /api/v1/github/repos
 */
export class ListReposQueryDto {
  @IsOptional()
  @IsInt()
  @Min(1)
  @Type(() => Number)
  page?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(100)
  @Type(() => Number)
  per_page?: number;
}

/**
 * Query DTO for GET /api/v1/github/search
 */
export class SearchReposQueryDto {
  @IsString()
  @MinLength(1)
  q: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Type(() => Number)
  page?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(100)
  @Type(() => Number)
  per_page?: number;
}

/**
 * Query DTO for GET /api/v1/github/repo-exists - a cheap pre-flight
 * existence check used by the repo-picker modal before it lets a
 * hand-typed repo URL trigger a (paid) generation run.
 */
export class RepoExistsQueryDto {
  @IsString()
  @MinLength(1)
  @Matches(GITHUB_NAME_SEGMENT, { message: 'owner must look like a GitHub username/org' })
  owner: string;

  @IsString()
  @MinLength(1)
  @Matches(GITHUB_NAME_SEGMENT, { message: 'repo must look like a GitHub repository name' })
  repo: string;
}
