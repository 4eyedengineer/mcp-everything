import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Add the missing `hosted_servers.user_id` -> `users.id` foreign key.
 *
 * The column was created in 1733200000000 with an index and a
 * "-- For future auth integration" comment, but no constraint, and the entity
 * declared no relation. Auth arrived; the constraint never did. Deleting an
 * account therefore left its hosted servers pointing at a user id that no
 * longer existed - rows that no user-scoped query can ever return again,
 * while their containers/pods keep running and consuming resources.
 *
 * WHY `ON DELETE RESTRICT` AND NOT CASCADE OR SET NULL
 * ----------------------------------------------------
 * The choice matters more than usual here because `hosted_servers` rows are
 * not merely data - each one is the handle on a live workload that exists
 * outside the database.
 *
 *   - CASCADE deletes the row. It does not stop the container or the
 *     Kubernetes Deployment. The workload keeps running with nothing left in
 *     the system that knows it exists, which is strictly worse than the
 *     current bug: today's orphan is at least still enumerable.
 *   - SET NULL keeps the row but disowns it. Every query in HostingService is
 *     user-scoped, so the server becomes invisible in the product while it
 *     keeps serving traffic. Better than CASCADE (an operator can still find
 *     it via SQL) but it still turns "you must clean this up" into silence.
 *   - RESTRICT makes the bad state unrepresentable: the database refuses to
 *     delete a user who still owns hosted servers, so the application is
 *     forced to tear them down first. `UserService.deleteUser` does that
 *     check up front and returns a 409 naming the servers, and nulls
 *     `user_id` on already soft-deleted ('deleted') rows - whose containers
 *     are stopped and images removed - so deployment history is retained
 *     without holding the constraint.
 *
 * RESTRICT is the only one of the three where a failure is loud. Given that
 * the failure mode being fixed is "silently orphans running servers", loud is
 * the point.
 *
 * Pre-existing orphans (user_id values with no matching users row, created
 * while there was no constraint) are set to NULL first - the constraint
 * cannot be added otherwise, and there is no user left to attribute them to.
 */
export class AddHostedServerUserForeignKey1754100000002 implements MigrationInterface {
  name = 'AddHostedServerUserForeignKey1754100000002';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Clear dangling references left behind by account deletions that
    // happened while no constraint existed.
    await queryRunner.query(`
      UPDATE hosted_servers hs
      SET user_id = NULL
      WHERE hs.user_id IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM users u WHERE u.id = hs.user_id)
    `);

    await queryRunner.query(`
      ALTER TABLE hosted_servers
      DROP CONSTRAINT IF EXISTS hosted_servers_user_id_fkey
    `);

    await queryRunner.query(`
      ALTER TABLE hosted_servers
      ADD CONSTRAINT hosted_servers_user_id_fkey
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE RESTRICT
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE hosted_servers
      DROP CONSTRAINT IF EXISTS hosted_servers_user_id_fkey
    `);
  }
}
