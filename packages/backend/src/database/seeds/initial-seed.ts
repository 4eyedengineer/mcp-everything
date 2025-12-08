import { DataSource } from 'typeorm';
import { User } from '../entities/user.entity';

/**
 * Initial Seed Data
 *
 * Creates demo/test data for local development.
 * This seed should only be run in development environments.
 *
 * Demo Accounts:
 * - demo@mcp-everything.local (Pro tier, for testing paid features)
 * - free@mcp-everything.local (Free tier, for testing limits)
 * - enterprise@mcp-everything.local (Enterprise tier, for testing enterprise features)
 */
export async function seedDatabase(dataSource: DataSource): Promise<void> {
  const userRepository = dataSource.getRepository(User);

  console.log('Checking existing seed data...');

  // Check if demo user already exists
  const existingDemoUser = await userRepository.findOne({
    where: { email: 'demo@mcp-everything.local' },
  });

  if (existingDemoUser) {
    console.log('Seed data already exists. Skipping...');
    return;
  }

  console.log('Creating demo users...');

  // Create demo Pro user
  const demoUser = userRepository.create({
    email: 'demo@mcp-everything.local',
    firstName: 'Demo',
    lastName: 'User',
    tier: 'pro',
    isEmailVerified: true,
    isActive: true,
  });
  await userRepository.save(demoUser);
  console.log(`  Created Pro user: ${demoUser.email} (ID: ${demoUser.id})`);

  // Create demo Free user
  const freeUser = userRepository.create({
    email: 'free@mcp-everything.local',
    firstName: 'Free',
    lastName: 'User',
    tier: 'free',
    isEmailVerified: true,
    isActive: true,
  });
  await userRepository.save(freeUser);
  console.log(`  Created Free user: ${freeUser.email} (ID: ${freeUser.id})`);

  // Create demo Enterprise user
  const enterpriseUser = userRepository.create({
    email: 'enterprise@mcp-everything.local',
    firstName: 'Enterprise',
    lastName: 'User',
    tier: 'enterprise',
    isEmailVerified: true,
    isActive: true,
  });
  await userRepository.save(enterpriseUser);
  console.log(
    `  Created Enterprise user: ${enterpriseUser.email} (ID: ${enterpriseUser.id})`,
  );

  console.log('Seed data created successfully!');
}
