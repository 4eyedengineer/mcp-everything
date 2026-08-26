/**
 * Dependency-inversion seam between hosting and the per-user credential
 * vault.
 *
 * `HostingService.deployToCloud` needs to turn a user-supplied
 * `credentialRefs` map (ENV_VAR_NAME -> stored credential NAME) into real
 * secret values to inject into a deploy, WITHOUT the hosting module owning -
 * or even importing - the vault's entity/service/module. The vault is being
 * built in a separate module (`src/credential-vault/**`) in parallel; binding
 * to it directly here would create a circular or premature dependency and
 * couple two features that only need to agree on one method signature.
 *
 * So hosting depends on this interface and DI token instead. At merge time,
 * `CREDENTIAL_RESOLVER` is bound to the real `CredentialVaultService` (which
 * implements `resolveForDeploy` with exactly this signature) via
 * `useExisting`. Until then, `HostingModule` binds a placeholder that throws
 * if ever invoked - see the comment on that provider in `hosting.module.ts`.
 */
export interface CredentialResolver {
  /**
   * Resolves a caller-supplied map of ENV_VAR_NAME -> stored credential NAME
   * into ENV_VAR_NAME -> secret VALUE, scoped to `userId` so one user can
   * never resolve another user's stored credential by guessing its name.
   *
   * Implementations MUST reject (throw) rather than silently drop an entry
   * when a referenced credential does not exist (or does not belong to
   * `userId`) - a deploy that silently omits a secret the caller explicitly
   * asked for is a worse failure mode than a deploy that never starts.
   */
  resolveForDeploy(userId: string, refs: Record<string, string>): Promise<Record<string, string>>;
}

/** DI token for {@link CredentialResolver}. See the interface doc for why this is a token, not a class. */
export const CREDENTIAL_RESOLVER = 'CREDENTIAL_RESOLVER';
