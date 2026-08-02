import { MigrationInterface, QueryRunner, TableColumn } from 'typeorm';

/**
 * Splits a hosted server's single `status` column into user intent
 * (`desired_state`) and cluster reality (`observed_*`).
 *
 * Why: `status` conflated the two. HostingService wrote 'running' the moment a
 * GitOps commit succeeded and nothing ever reconciled it afterwards, so a pod
 * stuck in CrashLoopBackOff read 'running' indefinitely, and
 * HostingController.getServerStatus fabricated replica counts from that string
 * (`status === 'running' ? 1 : 0`). With the GitOps path replaced by a direct
 * Kubernetes control plane there is now a real observed signal to record.
 *
 * Deliberately ADDITIVE - `status` is neither renamed nor dropped:
 *  - The frontend (hosting-api.service.ts, the servers list, deploy-progress)
 *    reads `status` and its existing union of values. Renaming it would have
 *    required a coordinated frontend change to avoid breaking the UI.
 *  - `status` becomes a derived mirror. K8sReconcilerService recomputes it
 *    from (desired_state, observed_status) on every pass, so old readers keep
 *    working unchanged while new readers get the honest fields.
 *
 * Backfill: existing rows get desired_state from their current status
 * ('stopped'/'deleted' preserved, everything else treated as intent to run).
 * observed_* are left NULL on purpose - nothing has been observed yet, and
 * inventing an observation here would recreate exactly the fabrication this
 * migration exists to remove. The reconciler fills them on its first pass.
 *
 * hasColumn guards follow the pattern established by
 * 1753900010000-FixMcpServersSchemaDrift.ts so this is a no-op against a dev
 * database that already picked the columns up via `synchronize: true`.
 */
export class AddHostedServerDesiredObservedState1754200000000 implements MigrationInterface {
  name = 'AddHostedServerDesiredObservedState1754200000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    if (!(await queryRunner.hasColumn('hosted_servers', 'desired_state'))) {
      await queryRunner.addColumn(
        'hosted_servers',
        new TableColumn({
          name: 'desired_state',
          type: 'varchar',
          length: '20',
          isNullable: false,
          default: "'running'",
        }),
      );

      // Preserve existing intent rather than declaring every historical row
      // "should be running" - a stopped or deleted server must not be revived
      // by the reconciler on its first pass.
      await queryRunner.query(`
        UPDATE hosted_servers
        SET desired_state = CASE
          WHEN status = 'stopped' THEN 'stopped'
          WHEN status = 'deleted' THEN 'deleted'
          ELSE 'running'
        END
      `);
    }

    if (!(await queryRunner.hasColumn('hosted_servers', 'observed_status'))) {
      await queryRunner.addColumn(
        'hosted_servers',
        new TableColumn({
          name: 'observed_status',
          type: 'varchar',
          length: '20',
          isNullable: true,
        }),
      );
    }

    if (!(await queryRunner.hasColumn('hosted_servers', 'observed_at'))) {
      await queryRunner.addColumn(
        'hosted_servers',
        new TableColumn({
          name: 'observed_at',
          type: 'timestamp',
          isNullable: true,
        }),
      );
    }

    if (!(await queryRunner.hasColumn('hosted_servers', 'observed_message'))) {
      await queryRunner.addColumn(
        'hosted_servers',
        new TableColumn({
          name: 'observed_message',
          type: 'text',
          isNullable: true,
        }),
      );
    }

    if (!(await queryRunner.hasColumn('hosted_servers', 'observed_replicas'))) {
      await queryRunner.addColumn(
        'hosted_servers',
        new TableColumn({
          name: 'observed_replicas',
          type: 'int',
          isNullable: true,
        }),
      );
    }

    if (!(await queryRunner.hasColumn('hosted_servers', 'observed_ready_replicas'))) {
      await queryRunner.addColumn(
        'hosted_servers',
        new TableColumn({
          name: 'observed_ready_replicas',
          type: 'int',
          isNullable: true,
        }),
      );
    }

    // The reconciler's per-pass query filters on desired_state and skips
    // deleted rows; without this it is a full scan of hosted_servers every
    // interval.
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_hosted_servers_desired_state
      ON hosted_servers(desired_state)
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS idx_hosted_servers_desired_state`);

    for (const column of [
      'observed_ready_replicas',
      'observed_replicas',
      'observed_message',
      'observed_at',
      'observed_status',
      'desired_state',
    ]) {
      if (await queryRunner.hasColumn('hosted_servers', column)) {
        await queryRunner.dropColumn('hosted_servers', column);
      }
    }
  }
}
