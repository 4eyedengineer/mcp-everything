import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Backfill `inputSchema` into `deployments.tools` and `hosted_servers.tools`.
 *
 * Root cause: the refinement loop produces a real JSON Schema per tool and
 * stores it at `conversations.state.generatedCode.metadata.tools[].inputSchema`,
 * but two projections on the way to these tables dropped it -
 * GenerationPipeline.syncGeneratedCodeToConversation kept only name+description
 * when writing `conversation.state.tools`, and
 * DeploymentOrchestratorService.persistDeploymentServerMetadata then wrote
 * `inputSchema: undefined` outright. HostingService copies `deployment.tools`
 * verbatim onto the hosted server, so the loss propagated. Both projections have
 * been fixed; this migration recovers the same data for existing rows.
 *
 * It invents nothing: every schema written here is copied from the
 * conversation that generated the server, matched by tool name.
 *
 * No DDL - both columns are already jsonb, so an extra key on the array
 * elements needs no schema change.
 *
 * Safety:
 * - Rows whose `tools` is NULL or not a jsonb array are skipped (the
 *   jsonb_array_elements input is coerced to '[]' first, which would otherwise
 *   raise "cannot extract elements from a scalar").
 * - Same coercion on the conversation side, so a missing/malformed
 *   `state.generatedCode.metadata.tools` simply yields no source schemas.
 * - `hosted_servers.conversation_id` is nullable (ON DELETE SET NULL), so that
 *   join is a LEFT JOIN: a hosted server whose conversation is gone keeps its
 *   tools exactly as they are.
 * - Only elements that are objects and whose `inputSchema` is absent or JSON
 *   null are touched, and only when a matching schema was actually found, so an
 *   already-correct row is never rewritten. Element order is preserved via
 *   WITH ORDINALITY.
 *
 * Idempotent: re-running finds nothing left to fill (the guard above), and the
 * final `IS DISTINCT FROM` means unchanged arrays are not even rewritten.
 */
export class BackfillToolInputSchemas1754600000000 implements MigrationInterface {
  name = 'BackfillToolInputSchemas1754600000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // deployments."conversationId" is NOT NULL (FK ON DELETE CASCADE), so an
    // inner join is correct here.
    const deployments = await queryRunner.query(`
      UPDATE deployments AS d
      SET tools = backfilled.tools
      FROM (
        SELECT
          d2.id AS deployment_id,
          jsonb_agg(
            CASE
              WHEN jsonb_typeof(t.elem) = 'object'
               AND (t.elem -> 'inputSchema' IS NULL OR jsonb_typeof(t.elem -> 'inputSchema') = 'null')
               AND src.input_schema IS NOT NULL
              THEN t.elem || jsonb_build_object('inputSchema', src.input_schema)
              ELSE t.elem
            END
            ORDER BY t.ord
          ) AS tools
        FROM deployments d2
        JOIN conversations c ON c.id = d2."conversationId"
        CROSS JOIN LATERAL jsonb_array_elements(
          CASE WHEN jsonb_typeof(d2.tools) = 'array' THEN d2.tools ELSE '[]'::jsonb END
        ) WITH ORDINALITY AS t(elem, ord)
        LEFT JOIN LATERAL (
          SELECT g.tool -> 'inputSchema' AS input_schema
          FROM jsonb_array_elements(
            CASE
              WHEN jsonb_typeof(c.state -> 'generatedCode' -> 'metadata' -> 'tools') = 'array'
              THEN c.state -> 'generatedCode' -> 'metadata' -> 'tools'
              ELSE '[]'::jsonb
            END
          ) AS g(tool)
          WHERE jsonb_typeof(g.tool) = 'object'
            AND jsonb_typeof(g.tool -> 'inputSchema') = 'object'
            AND g.tool ->> 'name' = t.elem ->> 'name'
          LIMIT 1
        ) AS src ON TRUE
        GROUP BY d2.id
      ) AS backfilled
      WHERE d.id = backfilled.deployment_id
        AND d.tools IS DISTINCT FROM backfilled.tools
    `);

    // hosted_servers.conversation_id is nullable (ON DELETE SET NULL) - LEFT
    // JOIN so a hosted server outliving its conversation is left untouched
    // rather than dropped from the backfill's result set.
    const hostedServers = await queryRunner.query(`
      UPDATE hosted_servers AS h
      SET tools = backfilled.tools
      FROM (
        SELECT
          h2.id AS hosted_server_id,
          jsonb_agg(
            CASE
              WHEN jsonb_typeof(t.elem) = 'object'
               AND (t.elem -> 'inputSchema' IS NULL OR jsonb_typeof(t.elem -> 'inputSchema') = 'null')
               AND src.input_schema IS NOT NULL
              THEN t.elem || jsonb_build_object('inputSchema', src.input_schema)
              ELSE t.elem
            END
            ORDER BY t.ord
          ) AS tools
        FROM hosted_servers h2
        LEFT JOIN conversations c ON c.id = h2.conversation_id
        CROSS JOIN LATERAL jsonb_array_elements(
          CASE WHEN jsonb_typeof(h2.tools) = 'array' THEN h2.tools ELSE '[]'::jsonb END
        ) WITH ORDINALITY AS t(elem, ord)
        LEFT JOIN LATERAL (
          SELECT g.tool -> 'inputSchema' AS input_schema
          FROM jsonb_array_elements(
            CASE
              WHEN jsonb_typeof(c.state -> 'generatedCode' -> 'metadata' -> 'tools') = 'array'
              THEN c.state -> 'generatedCode' -> 'metadata' -> 'tools'
              ELSE '[]'::jsonb
            END
          ) AS g(tool)
          WHERE jsonb_typeof(g.tool) = 'object'
            AND jsonb_typeof(g.tool -> 'inputSchema') = 'object'
            AND g.tool ->> 'name' = t.elem ->> 'name'
          LIMIT 1
        ) AS src ON TRUE
        GROUP BY h2.id
      ) AS backfilled
      WHERE h.id = backfilled.hosted_server_id
        AND h.tools IS DISTINCT FROM backfilled.tools
    `);

    // The postgres driver returns [rows, affectedRowCount] for UPDATE.
    const affected = (result: unknown): number =>
      Array.isArray(result) && typeof result[1] === 'number' ? result[1] : 0;

    const deploymentCount = affected(deployments);
    const hostedServerCount = affected(hostedServers);

    if (deploymentCount > 0 || hostedServerCount > 0) {
      console.log(
        `[BackfillToolInputSchemas] filled tool inputSchema on ${deploymentCount} deployment(s) ` +
          `and ${hostedServerCount} hosted server(s).`,
      );
    }
  }

  public async down(): Promise<void> {
    // Intentionally a no-op. This migration is purely additive: it copies
    // schemas that still exist on the originating conversation row into tool
    // objects that were missing them, and never removes or moves data. Undoing
    // it would mean re-stripping `inputSchema` from tools that are otherwise
    // indistinguishable from ones written by the (fixed) application code -
    // which would be destructive, not corrective. Leaving the schemas in place
    // is exactly what the current code writes anyway.
  }
}
