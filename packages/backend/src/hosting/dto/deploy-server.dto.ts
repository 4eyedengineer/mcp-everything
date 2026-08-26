import { IsString, IsOptional, MaxLength, IsObject } from 'class-validator';

export class DeployServerDto {
  @IsOptional()
  @IsString()
  @MaxLength(100)
  serverName?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string;

  /**
   * Environment variables to inject into the running container (e.g.
   * GITHUB_TOKEN for a generated GitHub API server). Matches the frontend's
   * DeployToCloudRequest.envVars contract
   * (core/services/hosting-api.service.ts). Previously accepted by this DTO
   * but never read - HostingController.deployServer bound the body to an
   * unused `_dto` parameter, so nothing a user typed into an env var field in
   * the UI ever reached the container.
   */
  @IsOptional()
  @IsObject()
  envVars?: Record<string, string>;

  /**
   * Map of environment-variable name to the NAME of one of the caller's
   * stored vault credentials (e.g. `{ "GITHUB_TOKEN": "my-github-pat" }`).
   * `HostingService.deployToCloud` resolves each referenced credential to its
   * real secret value server-side and injects it into the deploy env - the
   * raw secret never has to pass through this request body. Preferred over
   * putting a raw secret directly in `envVars`.
   */
  @IsOptional()
  @IsObject()
  credentialRefs?: Record<string, string>;
}
