import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Repoint existing hosted servers' `endpoint_url` at the MCP gateway.
 *
 * No schema change - this is a data migration.
 *
 * Before the gateway, `endpoint_url` held one of three things, none of which a
 * user could actually connect to:
 *
 *   1. `https://<serverId>.<domain>` (kubernetes mode). Never routable:
 *      ManifestGeneratorService deliberately emits only a ClusterIP Service and
 *      no Ingress, so there was no wildcard DNS record and no certificate
 *      behind these hostnames.
 *   2. `http://localhost:<port>` (docker-run + HTTP). Dialable only from the
 *      backend's own host, never by a user's MCP client.
 *   3. `docker-exec://<container>` (docker-run + stdio). Not a URL at all.
 *
 * All three are now replaced by the one address that works and is safe to
 * publish, because it authenticates and meters:
 *
 *   <MCP_GATEWAY_PUBLIC_URL>/api/hosting/servers/<server_id>/mcp
 *
 * Rows are matched by shape rather than blindly overwritten, so re-running this
 * (or running it after a deploy has already written a gateway URL) changes
 * nothing. `deleted` servers are skipped - their endpoint is historical.
 *
 * The base URL is read from the environment at migration time. That is a real
 * limitation: an operator who later changes MCP_GATEWAY_PUBLIC_URL will have
 * stale rows. It is acceptable because the value is derived, HostingService
 * .gatewayUrlFor() regenerates it on every subsequent deploy, and the
 * alternative - a computed column or a view - is a larger change than the
 * problem warrants.
 */
export class RepointHostedServerEndpointsAtGateway1754400000000
  implements MigrationInterface
{
  name = 'RepointHostedServerEndpointsAtGateway1754400000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const baseUrl = (process.env.MCP_GATEWAY_PUBLIC_URL || 'http://localhost:3000').replace(
      /\/+$/,
      '',
    );

    await queryRunner.query(
      `
      UPDATE hosted_servers
         SET endpoint_url = $1 || '/api/hosting/servers/' || server_id || '/mcp'
       WHERE status <> 'deleted'
         AND endpoint_url NOT LIKE '%/api/hosting/servers/%'
      `,
      [baseUrl],
    );
  }

  /**
   * Restores the kubernetes-mode subdomain shape only, using MCP_HOSTING_DOMAIN.
   *
   * This is intentionally lossy and cannot be otherwise: the original value
   * depended on the hosting mode and, for docker-run, on a port that is a hash
   * of the server id. Reversing it exactly would mean re-deriving state this
   * table no longer records. Since every one of the old shapes was unreachable,
   * a down-migration that restores "the old broken URL" and one that restores
   * "a different old broken URL" are equally useful - what matters is that
   * `up()` is re-runnable, which it is.
   */
  public async down(queryRunner: QueryRunner): Promise<void> {
    const domain = process.env.MCP_HOSTING_DOMAIN || 'mcp.example.com';

    await queryRunner.query(
      `
      UPDATE hosted_servers
         SET endpoint_url = 'https://' || server_id || '.' || $1
       WHERE status <> 'deleted'
         AND endpoint_url LIKE '%/api/hosting/servers/%'
      `,
      [domain],
    );
  }
}
