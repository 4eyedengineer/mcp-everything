import { DataSource } from 'typeorm';
import { config } from 'dotenv';
import { join } from 'path';

// Load environment variables from .env file
config();

/**
 * TypeORM Data Source Configuration
 *
 * This file is used by the TypeORM CLI for running migrations.
 * It uses the compiled JavaScript files from the dist directory.
 *
 * Usage:
 *   npm run build                    # Build the project first
 *   npm run migration:run            # Run pending migrations
 *   npm run migration:revert         # Revert the last migration
 *   npm run migration:show           # Show migration status
 *   npm run migration:generate name  # Generate a new migration
 *
 * Environment Variables:
 *   DATABASE_HOST     - PostgreSQL host (default: localhost)
 *   DATABASE_PORT     - PostgreSQL port (default: 5432)
 *   DATABASE_USER     - PostgreSQL user (default: postgres)
 *   DATABASE_PASSWORD - PostgreSQL password (default: postgres)
 *   DATABASE_NAME     - PostgreSQL database (default: mcp_everything)
 *   NODE_ENV          - Environment (development, production)
 */
export default new DataSource({
  type: 'postgres',
  host: process.env.DATABASE_HOST || 'localhost',
  port: parseInt(process.env.DATABASE_PORT || '5432', 10),
  username: process.env.DATABASE_USER || 'postgres',
  password: process.env.DATABASE_PASSWORD || 'postgres',
  database: process.env.DATABASE_NAME || 'mcp_everything',

  // Entity paths for compiled JavaScript files
  entities: [join(__dirname, '..', '**', '*.entity.js')],

  // Migration paths for compiled JavaScript files
  migrations: [join(__dirname, 'migrations', '*.js')],

  // Never use synchronize in production - always use migrations
  synchronize: false,

  // Enable logging in development
  logging: process.env.NODE_ENV === 'development',

  // Migration table name
  migrationsTableName: 'typeorm_migrations',

  // Migration transaction mode
  migrationsTransactionMode: 'each',
});
