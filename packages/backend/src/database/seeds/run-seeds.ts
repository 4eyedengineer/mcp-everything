import dataSource from '../data-source';
import { seedDatabase } from './initial-seed';

/**
 * Seed Runner
 *
 * Initializes the database connection and runs all seed functions.
 * This script is meant to be run after migrations have completed.
 *
 * Usage:
 *   npm run build && npm run seed
 *
 * Or via the migration script:
 *   ./scripts/run-migrations.sh --seed
 */
async function runSeeds(): Promise<void> {
  console.log('='.repeat(50));
  console.log('  MCP Everything - Database Seeding');
  console.log('='.repeat(50));
  console.log('');

  // Check environment
  if (process.env.NODE_ENV === 'production') {
    console.error('ERROR: Seeds should not be run in production!');
    console.error('Set NODE_ENV to development or test to run seeds.');
    process.exit(1);
  }

  try {
    console.log('Initializing database connection...');
    await dataSource.initialize();
    console.log('Database connection established.');
    console.log('');

    // Run seed functions
    await seedDatabase(dataSource);

    console.log('');
    console.log('='.repeat(50));
    console.log('  Seeding completed successfully!');
    console.log('='.repeat(50));
  } catch (error) {
    console.error('Seeding failed:', error);
    process.exit(1);
  } finally {
    if (dataSource.isInitialized) {
      await dataSource.destroy();
      console.log('Database connection closed.');
    }
  }
}

runSeeds();
