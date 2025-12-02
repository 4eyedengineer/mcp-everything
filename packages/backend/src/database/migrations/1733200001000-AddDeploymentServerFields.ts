import { MigrationInterface, QueryRunner, TableColumn } from 'typeorm';

export class AddDeploymentServerFields1733200001000
  implements MigrationInterface
{
  name = 'AddDeploymentServerFields1733200001000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Add server metadata columns to deployments table
    await queryRunner.addColumns('deployments', [
      new TableColumn({
        name: 'serverName',
        type: 'varchar',
        length: '100',
        isNullable: true,
      }),
      new TableColumn({
        name: 'description',
        type: 'text',
        isNullable: true,
      }),
      new TableColumn({
        name: 'tools',
        type: 'jsonb',
        isNullable: true,
      }),
      new TableColumn({
        name: 'envVars',
        type: 'jsonb',
        isNullable: true,
      }),
      new TableColumn({
        name: 'localPath',
        type: 'text',
        isNullable: true,
      }),
    ]);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.dropColumn('deployments', 'localPath');
    await queryRunner.dropColumn('deployments', 'envVars');
    await queryRunner.dropColumn('deployments', 'tools');
    await queryRunner.dropColumn('deployments', 'description');
    await queryRunner.dropColumn('deployments', 'serverName');
  }
}
