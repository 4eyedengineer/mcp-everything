import { DataSource } from 'typeorm';
import { User } from '../entities/user.entity';
import { McpServer } from '../entities/mcp-server.entity';

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
 *
 * Marketplace Servers:
 * - Seeds ~6 realistic MCP server listings so the Explore page has real rows
 *   to render instead of an empty state. Each server is checked by slug and
 *   skipped individually if it already exists, so this function is safe to
 *   run multiple times (e.g. on every backend boot).
 */
export async function seedDatabase(dataSource: DataSource): Promise<void> {
  const userRepository = dataSource.getRepository(User);
  const serverRepository = dataSource.getRepository(McpServer);

  console.log('Checking existing seed data...');

  // Check if demo user already exists
  let demoUser = await userRepository.findOne({
    where: { email: 'demo@mcp-everything.local' },
  });
  let freeUser = await userRepository.findOne({
    where: { email: 'free@mcp-everything.local' },
  });
  let enterpriseUser = await userRepository.findOne({
    where: { email: 'enterprise@mcp-everything.local' },
  });

  if (demoUser) {
    console.log('Demo users already exist. Skipping user seed...');
  } else {
    console.log('Creating demo users...');

    // Create demo Pro user
    demoUser = userRepository.create({
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
    freeUser = userRepository.create({
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
    enterpriseUser = userRepository.create({
      email: 'enterprise@mcp-everything.local',
      firstName: 'Enterprise',
      lastName: 'User',
      tier: 'enterprise',
      isEmailVerified: true,
      isActive: true,
    });
    await userRepository.save(enterpriseUser);
    console.log(`  Created Enterprise user: ${enterpriseUser.email} (ID: ${enterpriseUser.id})`);

    console.log('Seed data created successfully!');
  }

  await seedMarketplaceServers(serverRepository, demoUser, freeUser, enterpriseUser);
}

/**
 * Seed the marketplace with a handful of realistic MCP server listings.
 *
 * These are honest, illustrative entries (not tied to real published
 * packages) covering common MCP server categories - API integrations,
 * database connectors, communication tools, and utilities - so the
 * marketplace/Explore UI has real data to render during local development
 * and demos. Download counts are small, plausible numbers; 0 would also be
 * honest but non-zero values exercise the "popular" sort.
 */
async function seedMarketplaceServers(
  serverRepository: import('typeorm').Repository<McpServer>,
  demoUser: User | null,
  freeUser: User | null,
  enterpriseUser: User | null,
): Promise<void> {
  const now = new Date();

  const servers: Array<Partial<McpServer>> = [
    {
      name: 'GitHub Integration Server',
      slug: 'github-integration-server',
      description:
        'Browse repositories, read files, search code, and manage issues and pull requests directly from your MCP client.',
      longDescription:
        'Exposes GitHub REST API operations as MCP tools: repository search, file content retrieval, issue/PR listing and creation, and commit history. Requires a GitHub personal access token with repo scope.',
      category: 'devtools',
      tags: ['github', 'git', 'repository', 'issues', 'pull-requests'],
      visibility: 'public',
      authorId: demoUser?.id,
      repositoryUrl: 'https://github.com/example/mcp-github-server',
      tools: [
        { name: 'search_repositories', description: 'Search GitHub repositories by query' , inputSchema: {} },
        { name: 'get_file_contents', description: 'Read a file from a repository at a given ref' , inputSchema: {} },
        { name: 'list_issues', description: 'List issues for a repository' , inputSchema: {} },
        { name: 'create_pull_request', description: 'Open a new pull request' , inputSchema: {} },
      ],
      envVars: ['GITHUB_TOKEN'],
      language: 'typescript',
      downloadCount: 342,
      rating: 4.8,
      ratingCount: 51,
      status: 'approved',
      featured: true,
      publishedAt: now,
    },
    {
      name: 'Stripe Payments Server',
      slug: 'stripe-payments-server',
      description:
        'Query customers, charges, subscriptions, and invoices, and create test-mode payments from your MCP client.',
      longDescription:
        'Wraps the Stripe API for read-heavy MCP workflows: look up customers and subscriptions, inspect recent charges, and create test-mode payment intents. Ships with sandbox-safe defaults; production use requires a live secret key.',
      category: 'api',
      tags: ['stripe', 'payments', 'billing', 'subscriptions'],
      visibility: 'public',
      authorId: demoUser?.id,
      repositoryUrl: 'https://github.com/example/mcp-stripe-server',
      tools: [
        { name: 'get_customer', description: 'Retrieve a customer by ID or email' , inputSchema: {} },
        { name: 'list_charges', description: 'List recent charges with optional filters' , inputSchema: {} },
        { name: 'create_payment_intent', description: 'Create a payment intent (test mode)' , inputSchema: {} },
      ],
      envVars: ['STRIPE_SECRET_KEY'],
      language: 'typescript',
      downloadCount: 210,
      rating: 4.6,
      ratingCount: 34,
      status: 'approved',
      featured: true,
      publishedAt: now,
    },
    {
      name: 'PostgreSQL Connector',
      slug: 'postgresql-connector',
      description:
        'Run read-only SQL queries, inspect table schemas, and explore relationships in a PostgreSQL database.',
      longDescription:
        'Connects to a PostgreSQL instance and exposes schema introspection and parameterized read-only query tools. Write operations are disabled by default for safety; enable them explicitly via configuration.',
      category: 'database',
      tags: ['postgresql', 'sql', 'database', 'schema'],
      visibility: 'public',
      authorId: freeUser?.id,
      repositoryUrl: 'https://github.com/example/mcp-postgres-server',
      tools: [
        { name: 'list_tables', description: 'List tables in the connected database/schema' , inputSchema: {} },
        { name: 'describe_table', description: 'Get column definitions for a table' , inputSchema: {} },
        { name: 'run_query', description: 'Execute a read-only parameterized SQL query' , inputSchema: {} },
      ],
      envVars: ['DATABASE_URL'],
      language: 'typescript',
      downloadCount: 156,
      rating: 4.4,
      ratingCount: 22,
      status: 'approved',
      featured: false,
      publishedAt: now,
    },
    {
      name: 'Slack Notifications Server',
      slug: 'slack-notifications-server',
      description:
        'Post messages, read channel history, and search conversations in Slack workspaces.',
      longDescription:
        'Uses a Slack bot token to post and read messages, list channels, and search conversation history. Useful for notification workflows and lightweight team-chat automation from an MCP client.',
      category: 'communication',
      tags: ['slack', 'chat', 'notifications', 'messaging'],
      visibility: 'public',
      authorId: enterpriseUser?.id,
      repositoryUrl: 'https://github.com/example/mcp-slack-server',
      tools: [
        { name: 'post_message', description: 'Post a message to a channel or user' , inputSchema: {} },
        { name: 'list_channels', description: 'List channels the bot has access to' , inputSchema: {} },
        { name: 'search_messages', description: 'Search message history across channels' , inputSchema: {} },
      ],
      envVars: ['SLACK_BOT_TOKEN'],
      language: 'typescript',
      downloadCount: 98,
      rating: 4.2,
      ratingCount: 15,
      status: 'approved',
      featured: false,
      publishedAt: now,
    },
    {
      name: 'Weather Data Server',
      slug: 'weather-data-server',
      description:
        'Get current conditions and short-term forecasts for any location by coordinates or city name.',
      longDescription:
        'Fetches current weather and multi-day forecasts from a public weather API. Supports lookup by city name, postal code, or latitude/longitude, with optional unit conversion (metric/imperial).',
      category: 'api',
      tags: ['weather', 'forecast', 'api'],
      visibility: 'public',
      authorId: freeUser?.id,
      repositoryUrl: 'https://github.com/example/mcp-weather-server',
      tools: [
        { name: 'get_current_weather', description: 'Get current conditions for a location' , inputSchema: {} },
        { name: 'get_forecast', description: 'Get a multi-day forecast for a location' , inputSchema: {} },
      ],
      envVars: ['WEATHER_API_KEY'],
      language: 'python',
      downloadCount: 47,
      rating: 4.0,
      ratingCount: 9,
      status: 'approved',
      featured: false,
      publishedAt: now,
    },
    {
      name: 'Filesystem Tools Server',
      slug: 'filesystem-tools-server',
      description:
        'Read, write, and search files within a sandboxed directory - list contents, grep for text, and edit files safely.',
      longDescription:
        'Exposes a restricted set of filesystem operations scoped to a configured root directory: list/read/write files, recursive search, and diff-based edits. All paths are resolved and validated against the root to prevent traversal outside the sandbox.',
      category: 'utility',
      tags: ['filesystem', 'files', 'search', 'sandbox'],
      visibility: 'public',
      authorId: demoUser?.id,
      repositoryUrl: 'https://github.com/example/mcp-filesystem-server',
      tools: [
        { name: 'read_file', description: 'Read the contents of a file' , inputSchema: {} },
        { name: 'write_file', description: 'Write or overwrite a file' , inputSchema: {} },
        { name: 'search_files', description: 'Search for text across files in the sandbox root' , inputSchema: {} },
      ],
      envVars: ['MCP_SANDBOX_ROOT'],
      language: 'typescript',
      downloadCount: 289,
      rating: 4.7,
      ratingCount: 41,
      status: 'approved',
      featured: false,
      publishedAt: now,
    },
  ];

  console.log('Checking marketplace server seed data...');

  let created = 0;
  let skipped = 0;

  for (const serverData of servers) {
    const existing = await serverRepository.findOne({ where: { slug: serverData.slug } });
    if (existing) {
      skipped++;
      continue;
    }

    const server = serverRepository.create(serverData);
    await serverRepository.save(server);
    created++;
    console.log(`  Created MCP server: ${serverData.name} (slug: ${serverData.slug})`);
  }

  console.log(`Marketplace seed complete: ${created} created, ${skipped} already existed.`);
}
