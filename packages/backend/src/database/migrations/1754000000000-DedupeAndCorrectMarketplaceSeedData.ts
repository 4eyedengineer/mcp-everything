import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Data-repair migration for the marketplace seed data incident.
 *
 * BACKGROUND
 * ----------
 * `packages/backend/src/database/seeds/initial-seed.ts` used to seed 6
 * "realistic-looking" marketplace listings with FABRICATED social proof:
 * invented `downloadCount`/`rating`/`ratingCount` values (e.g. 342 downloads,
 * 4.8 stars from 51 ratings) and a `repositoryUrl` pointing at a repo that
 * does not exist (`github.com/example/mcp-<name>-server`). Because the seed
 * was re-run against at least one environment before per-slug idempotency
 * was airtight, duplicate rows for the same fabricated listing exist in some
 * databases (observed: 12 rows = 2x each of the 6 listings in production).
 *
 * This migration is a pure DATA repair - no schema/DDL changes, so it does
 * not trip the "no drift between migrations and entities" CI check. It:
 *
 *   1. For each of the 6 known fabricated listings (matched by their exact,
 *      distinctive `name` - see LEGACY_LISTINGS below), finds every row with
 *      that name.
 *   2. If a row for the honest replacement already exists (matched by the
 *      new `slug`), every legacy row for that listing is simply deleted -
 *      the honest row already covers it.
 *   3. Otherwise, the single oldest legacy row (by `createdAt`, then `id` as
 *      a tie-breaker) is REWRITTEN in place to become the honest replacement
 *      (a real, verifiable official MCP reference server from
 *      github.com/modelcontextprotocol/servers, with `downloadCount`,
 *      `rating`, and `ratingCount` reset to their honest zero value and
 *      `authorId` cleared, since none of these were authored by an MCP
 *      Everything user) - and any *other* duplicate legacy rows for that
 *      same listing are deleted.
 *   4. As a defense-in-depth safety net, ANY remaining row (not covered by
 *      the 6 known listings above, e.g. a fabricated listing this migration
 *      doesn't know the name of) whose `repositoryUrl` still points at the
 *      nonexistent `github.com/example/` namespace has its `downloadCount`,
 *      `rating`, `ratingCount` zeroed and its dead `repositoryUrl` cleared,
 *      so no fabricated social proof or dead link can survive this
 *      migration under any circumstance.
 *
 * Safe to run against a database with zero, six, twelve, or any other number
 * of these rows, and safe to run more than once: after the first run, no row
 * matches a `LEGACY_LISTINGS` name anymore (they've all been renamed to the
 * honest replacement name or deleted), so every subsequent run is a no-op.
 *
 * HARD CONSTRAINT: this migration only ever touches `mcp_servers` rows. It
 * never touches `users` (including the `demo@mcp-everything.local` /
 * `free@mcp-everything.local` / `enterprise@mcp-everything.local` seed
 * accounts) or any other table.
 */
export class DedupeAndCorrectMarketplaceSeedData1754000000000 implements MigrationInterface {
  name = 'DedupeAndCorrectMarketplaceSeedData1754000000000';

  /**
   * The 6 fabricated listings this migration knows how to repair, keyed by
   * their exact legacy `name` (unique/distinctive enough that a name
   * collision with a genuine, unrelated user-submitted server is not a
   * realistic concern), and the honest replacement data to rewrite the
   * surviving row to. Every `repositoryUrl` below was verified (curl -o
   * /dev/null -w '%{http_code}') to resolve with HTTP 200 as of 2026-07-29.
   */
  private static readonly LEGACY_LISTINGS: Array<{
    legacyName: string;
    replacement: {
      name: string;
      slug: string;
      description: string;
      longDescription: string;
      category: string;
      tags: string[];
      repositoryUrl: string;
      tools: Array<{ name: string; description: string; inputSchema: Record<string, unknown> }>;
      envVars: string[] | null;
      language: 'typescript' | 'python' | 'javascript';
    };
  }> = [
    {
      legacyName: 'GitHub Integration Server',
      replacement: {
        name: 'Filesystem Reference Server',
        slug: 'filesystem-reference-server',
        description:
          'Official MCP reference server for secure, sandboxed file operations - read, write, edit, and search files within explicitly allowed directories.',
        longDescription:
          'This is the official "filesystem" reference server maintained by the Model Context Protocol project (github.com/modelcontextprotocol/servers). It is listed here as a real, runnable example, not authored or hosted by MCP Everything. Access is restricted to directories passed on the command line or granted via the MCP Roots protocol.',
        category: 'utility',
        tags: ['filesystem', 'files', 'reference', 'mcp-official'],
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
            description:
              'Make selective edits using pattern matching, with dry-run preview support',
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
        envVars: null,
        language: 'typescript',
      },
    },
    {
      legacyName: 'Stripe Payments Server',
      replacement: {
        name: 'Fetch Reference Server',
        slug: 'fetch-reference-server',
        description:
          'Official MCP reference server that fetches a URL and converts its content to markdown for efficient LLM consumption.',
        longDescription:
          'This is the official "fetch" reference server maintained by the Model Context Protocol project (github.com/modelcontextprotocol/servers). It is listed here as a real, runnable example, not authored or hosted by MCP Everything.',
        category: 'api',
        tags: ['web', 'fetch', 'http', 'reference', 'mcp-official'],
        repositoryUrl: 'https://github.com/modelcontextprotocol/servers/tree/main/src/fetch',
        tools: [
          {
            name: 'fetch',
            description: 'Fetch a URL from the internet and extract its contents as markdown',
            inputSchema: {},
          },
        ],
        envVars: null,
        language: 'python',
      },
    },
    {
      legacyName: 'PostgreSQL Connector',
      replacement: {
        name: 'Git Reference Server',
        slug: 'git-reference-server',
        description:
          'Official MCP reference server exposing Git operations - status, diff, commit, log, branch, and checkout - against a local repository.',
        longDescription:
          'This is the official "git" reference server maintained by the Model Context Protocol project (github.com/modelcontextprotocol/servers). It is listed here as a real, runnable example, not authored or hosted by MCP Everything. Takes a `--repository` path at startup.',
        category: 'devtools',
        tags: ['git', 'version-control', 'reference', 'mcp-official'],
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
        envVars: null,
        language: 'python',
      },
    },
    {
      legacyName: 'Slack Notifications Server',
      replacement: {
        name: 'Memory Reference Server',
        slug: 'memory-reference-server',
        description:
          'Official MCP reference server implementing a persistent, knowledge-graph-based memory system of entities, relations, and observations.',
        longDescription:
          'This is the official "memory" reference server maintained by the Model Context Protocol project (github.com/modelcontextprotocol/servers). It is listed here as a real, runnable example, not authored or hosted by MCP Everything.',
        category: 'ai',
        tags: ['memory', 'knowledge-graph', 'ai', 'reference', 'mcp-official'],
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
      },
    },
    {
      legacyName: 'Weather Data Server',
      replacement: {
        name: 'Sequential Thinking Reference Server',
        slug: 'sequential-thinking-reference-server',
        description:
          'Official MCP reference server for dynamic, reflective problem-solving through revisable, branching thought sequences.',
        longDescription:
          'This is the official "sequentialthinking" reference server maintained by the Model Context Protocol project (github.com/modelcontextprotocol/servers). It is listed here as a real, runnable example, not authored or hosted by MCP Everything.',
        category: 'ai',
        tags: ['reasoning', 'planning', 'ai', 'reference', 'mcp-official'],
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
      },
    },
    {
      legacyName: 'Filesystem Tools Server',
      replacement: {
        name: 'Time Reference Server',
        slug: 'time-reference-server',
        description:
          'Official MCP reference server for getting the current time and converting times between IANA timezones.',
        longDescription:
          'This is the official "time" reference server maintained by the Model Context Protocol project (github.com/modelcontextprotocol/servers). It is listed here as a real, runnable example, not authored or hosted by MCP Everything.',
        category: 'utility',
        tags: ['time', 'timezone', 'utility', 'reference', 'mcp-official'],
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
      },
    },
  ];

  public async up(queryRunner: QueryRunner): Promise<void> {
    for (const {
      legacyName,
      replacement,
    } of DedupeAndCorrectMarketplaceSeedData1754000000000.LEGACY_LISTINGS) {
      // Does the honest replacement already exist (e.g. a fixed seed already ran)?
      const targetRows: Array<{ id: string }> = await queryRunner.query(
        `SELECT id FROM "mcp_servers" WHERE "slug" = $1 LIMIT 1`,
        [replacement.slug],
      );

      const legacyRows: Array<{ id: string }> = await queryRunner.query(
        `SELECT id FROM "mcp_servers" WHERE "name" = $1 ORDER BY "createdAt" ASC, "id" ASC`,
        [legacyName],
      );

      if (legacyRows.length === 0) {
        continue; // nothing to repair for this listing
      }

      if (targetRows.length > 0) {
        // Honest row already present - every legacy row is a pure duplicate.
        await queryRunner.query(`DELETE FROM "mcp_servers" WHERE "name" = $1`, [legacyName]);
        continue;
      }

      // No honest row yet - rewrite the oldest legacy row in place and drop
      // any remaining duplicates of it.
      const [canonical, ...duplicates] = legacyRows;

      await queryRunner.query(
        `
        UPDATE "mcp_servers" SET
          "name" = $1,
          "slug" = $2,
          "description" = $3,
          "longDescription" = $4,
          "category" = $5,
          "tags" = $6,
          "repositoryUrl" = $7,
          "gistUrl" = NULL,
          "downloadUrl" = NULL,
          "tools" = $8::jsonb,
          "envVars" = $9,
          "language" = $10,
          "downloadCount" = 0,
          "rating" = 0,
          "ratingCount" = 0,
          "authorId" = NULL,
          "status" = 'approved',
          "visibility" = 'public',
          "featured" = false,
          "publishedAt" = COALESCE("publishedAt", NOW()),
          "updatedAt" = NOW()
        WHERE "id" = $11
        `,
        [
          replacement.name,
          replacement.slug,
          replacement.description,
          replacement.longDescription,
          replacement.category,
          replacement.tags,
          replacement.repositoryUrl,
          JSON.stringify(replacement.tools),
          replacement.envVars,
          replacement.language,
          canonical.id,
        ],
      );

      if (duplicates.length > 0) {
        await queryRunner.query(`DELETE FROM "mcp_servers" WHERE "id" = ANY($1::uuid[])`, [
          duplicates.map((d) => d.id),
        ]);
      }
    }

    // Safety net: zero out any other row that still points at the known-fake
    // `github.com/example/` namespace, whatever its name.
    await queryRunner.query(`
      UPDATE "mcp_servers"
      SET "downloadCount" = 0, "rating" = 0, "ratingCount" = 0, "repositoryUrl" = NULL, "updatedAt" = NOW()
      WHERE "repositoryUrl" LIKE 'https://github.com/example/%'
    `);
  }

  public async down(): Promise<void> {
    // Intentionally irreversible: this migration repairs fabricated data
    // (fake download/rating counts, dead repository URLs) and de-duplicates
    // rows. There is no honest way to "restore" invented social proof, and
    // re-creating deleted duplicate rows isn't meaningful. A down migration
    // that no-ops (rather than resurrecting fake data) is the safer choice.
  }
}
