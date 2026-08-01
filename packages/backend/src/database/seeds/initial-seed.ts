import { DataSource } from 'typeorm';
import { User } from '../entities/user.entity';
import { McpServer } from '../entities/mcp-server.entity';

/**
 * Initial Seed Data
 *
 * Creates demo/test data for local development.
 * This seed should only be run in development environments.
 *
 * NOT wired into app bootstrap: this function only runs when explicitly
 * invoked via `npm run seed` (packages/backend/src/database/seeds/run-seeds.ts).
 * It does NOT run automatically on backend boot/start - if the marketplace or
 * demo accounts look empty, that's why. See DEVELOPMENT.md "Seeding Demo Data".
 *
 * Demo Accounts:
 * - demo@mcp-everything.local (Pro tier, for testing paid features)
 * - free@mcp-everything.local (Free tier, for testing limits)
 * - enterprise@mcp-everything.local (Enterprise tier, for testing enterprise features)
 *
 * Marketplace Servers:
 * - Seeds the 6 official MCP reference servers (github.com/modelcontextprotocol/servers)
 *   so the Explore page has real, verifiable rows instead of an empty state
 *   or fabricated listings. Each server is checked by slug and skipped
 *   individually if it already exists, so this function is safe to run
 *   multiple times (idempotent) whenever `npm run seed` is invoked - it will
 *   never create duplicate rows for the same slug.
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

  await seedMarketplaceServers(serverRepository);
}

/**
 * Seed the marketplace with real, independently-verifiable MCP servers.
 *
 * IMPORTANT - honesty constraint: this marketplace will have real users, so
 * seed rows must never fabricate social proof. Every entry below is one of
 * the official reference servers maintained in the
 * https://github.com/modelcontextprotocol/servers monorepo - the
 * `repositoryUrl` for each points at the real `src/<name>` subdirectory
 * (verified to resolve with a 200 as of 2026-07-29), and the `tools` list is
 * taken from that server's actual README, not invented. `downloadCount`,
 * `rating`, and `ratingCount` all start at their honest zero/default value -
 * they are never seeded with a number, and will only ever change via real
 * recorded activity (marketplace downloads/ratings). No `authorId` is set,
 * since none of these were authored by an MCP Everything user account - the
 * demo/free/enterprise seed users exist for testing tiers/quotas, not to be
 * misattributed as the author of third-party open-source servers.
 */
async function seedMarketplaceServers(
  serverRepository: import('typeorm').Repository<McpServer>,
): Promise<void> {
  // Honest timestamp: these rows really are being published right now, as
  // opposed to the fabricated download/rating counts this replaces.
  const now = new Date();

  const servers: Array<Partial<McpServer>> = [
    {
      name: 'Filesystem Reference Server',
      slug: 'filesystem-reference-server',
      description:
        'Official MCP reference server for secure, sandboxed file operations - read, write, edit, and search files within explicitly allowed directories.',
      longDescription:
        'This is the official "filesystem" reference server maintained by the Model Context Protocol project (github.com/modelcontextprotocol/servers). It is listed here as a real, runnable example, not authored or hosted by MCP Everything. Access is restricted to directories passed on the command line or granted via the MCP Roots protocol.',
      category: 'utility',
      tags: ['filesystem', 'files', 'reference', 'mcp-official'],
      visibility: 'public',
      repositoryUrl: 'https://github.com/modelcontextprotocol/servers/tree/main/src/filesystem',
      tools: [
        {
          name: 'read_text_file',
          description:
            'Read complete file contents as UTF-8 text, with optional head/tail filtering',
          inputSchema: {},
        },
        {
          name: 'write_file',
          description: 'Create a new file or overwrite an existing file with provided content',
          inputSchema: {},
        },
        {
          name: 'edit_file',
          description: 'Make selective edits using pattern matching, with dry-run preview support',
          inputSchema: {},
        },
        {
          name: 'search_files',
          description: 'Recursively search for files matching glob-style patterns',
          inputSchema: {},
        },
        {
          name: 'list_directory',
          description: 'List directory contents, with [FILE]/[DIR] prefixes',
          inputSchema: {},
        },
      ],
      language: 'typescript',
      downloadCount: 0,
      rating: 0,
      ratingCount: 0,
      status: 'approved',
      featured: false,
      publishedAt: now,
    },
    {
      name: 'Fetch Reference Server',
      slug: 'fetch-reference-server',
      description:
        'Official MCP reference server that fetches a URL and converts its content to markdown for efficient LLM consumption.',
      longDescription:
        'This is the official "fetch" reference server maintained by the Model Context Protocol project (github.com/modelcontextprotocol/servers). It is listed here as a real, runnable example, not authored or hosted by MCP Everything.',
      category: 'api',
      tags: ['web', 'fetch', 'http', 'reference', 'mcp-official'],
      visibility: 'public',
      repositoryUrl: 'https://github.com/modelcontextprotocol/servers/tree/main/src/fetch',
      tools: [
        {
          name: 'fetch',
          description: 'Fetch a URL from the internet and extract its contents as markdown',
          inputSchema: {},
        },
      ],
      language: 'python',
      downloadCount: 0,
      rating: 0,
      ratingCount: 0,
      status: 'approved',
      featured: false,
      publishedAt: now,
    },
    {
      name: 'Git Reference Server',
      slug: 'git-reference-server',
      description:
        'Official MCP reference server exposing Git operations - status, diff, commit, log, branch, and checkout - against a local repository.',
      longDescription:
        'This is the official "git" reference server maintained by the Model Context Protocol project (github.com/modelcontextprotocol/servers). It is listed here as a real, runnable example, not authored or hosted by MCP Everything. Takes a `--repository` path at startup.',
      category: 'devtools',
      tags: ['git', 'version-control', 'reference', 'mcp-official'],
      visibility: 'public',
      repositoryUrl: 'https://github.com/modelcontextprotocol/servers/tree/main/src/git',
      tools: [
        {
          name: 'git_status',
          description: 'Show the current working tree status of a repository',
          inputSchema: {},
        },
        {
          name: 'git_diff',
          description: 'Compare the current state against specified branches or commits',
          inputSchema: {},
        },
        {
          name: 'git_commit',
          description: 'Record staged changes to the repository with a message',
          inputSchema: {},
        },
        {
          name: 'git_log',
          description: 'Retrieve commit history with optional date range filtering',
          inputSchema: {},
        },
        {
          name: 'git_checkout',
          description: 'Switch the working directory to a different branch',
          inputSchema: {},
        },
      ],
      language: 'python',
      downloadCount: 0,
      rating: 0,
      ratingCount: 0,
      status: 'approved',
      featured: false,
      publishedAt: now,
    },
    {
      name: 'Memory Reference Server',
      slug: 'memory-reference-server',
      description:
        'Official MCP reference server implementing a persistent, knowledge-graph-based memory system of entities, relations, and observations.',
      longDescription:
        'This is the official "memory" reference server maintained by the Model Context Protocol project (github.com/modelcontextprotocol/servers). It is listed here as a real, runnable example, not authored or hosted by MCP Everything.',
      category: 'ai',
      tags: ['memory', 'knowledge-graph', 'ai', 'reference', 'mcp-official'],
      visibility: 'public',
      repositoryUrl: 'https://github.com/modelcontextprotocol/servers/tree/main/src/memory',
      tools: [
        {
          name: 'create_entities',
          description: 'Create multiple new entities in the knowledge graph',
          inputSchema: {},
        },
        {
          name: 'create_relations',
          description: 'Create multiple new relations between entities',
          inputSchema: {},
        },
        {
          name: 'search_nodes',
          description: 'Search for nodes in the knowledge graph based on a query',
          inputSchema: {},
        },
        { name: 'read_graph', description: 'Read the entire knowledge graph', inputSchema: {} },
      ],
      envVars: ['MEMORY_FILE_PATH'],
      language: 'typescript',
      downloadCount: 0,
      rating: 0,
      ratingCount: 0,
      status: 'approved',
      featured: false,
      publishedAt: now,
    },
    {
      name: 'Sequential Thinking Reference Server',
      slug: 'sequential-thinking-reference-server',
      description:
        'Official MCP reference server for dynamic, reflective problem-solving through revisable, branching thought sequences.',
      longDescription:
        'This is the official "sequentialthinking" reference server maintained by the Model Context Protocol project (github.com/modelcontextprotocol/servers). It is listed here as a real, runnable example, not authored or hosted by MCP Everything.',
      category: 'ai',
      tags: ['reasoning', 'planning', 'ai', 'reference', 'mcp-official'],
      visibility: 'public',
      repositoryUrl:
        'https://github.com/modelcontextprotocol/servers/tree/main/src/sequentialthinking',
      tools: [
        {
          name: 'sequential_thinking',
          description:
            'Structured, step-by-step problem-solving that can revise and branch as understanding develops',
          inputSchema: {},
        },
      ],
      envVars: ['DISABLE_THOUGHT_LOGGING'],
      language: 'typescript',
      downloadCount: 0,
      rating: 0,
      ratingCount: 0,
      status: 'approved',
      featured: false,
      publishedAt: now,
    },
    {
      name: 'Time Reference Server',
      slug: 'time-reference-server',
      description:
        'Official MCP reference server for getting the current time and converting times between IANA timezones.',
      longDescription:
        'This is the official "time" reference server maintained by the Model Context Protocol project (github.com/modelcontextprotocol/servers). It is listed here as a real, runnable example, not authored or hosted by MCP Everything.',
      category: 'utility',
      tags: ['time', 'timezone', 'utility', 'reference', 'mcp-official'],
      visibility: 'public',
      repositoryUrl: 'https://github.com/modelcontextprotocol/servers/tree/main/src/time',
      tools: [
        {
          name: 'get_current_time',
          description: 'Get the current time in a specific timezone or the system timezone',
          inputSchema: {},
        },
        {
          name: 'convert_time',
          description: 'Convert a time from one IANA timezone to another',
          inputSchema: {},
        },
      ],
      envVars: ['LOCAL_TIMEZONE'],
      language: 'python',
      downloadCount: 0,
      rating: 0,
      ratingCount: 0,
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
