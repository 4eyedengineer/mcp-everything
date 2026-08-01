/**
 * Builds a real, runnable install command for a marketplace server detail
 * page.
 *
 * Background: the marketplace is currently seeded with the official
 * modelcontextprotocol/servers reference servers, whose `repositoryUrl`
 * points at a *subdirectory* of that monorepo, e.g.
 *   https://github.com/modelcontextprotocol/servers/tree/main/src/fetch
 * That URL is a GitHub web-UI path, not a clonable git remote - naively
 * running `git clone <that-url>` fails with "repository not found" (exit
 * 128). This module fixes that at the source: it recognizes GitHub
 * "tree/<branch>/<path>" subdirectory URLs and either
 *   1) maps known modelcontextprotocol/servers subdirectories to their real,
 *      documented npx/uvx invocation (the genuinely useful path - no clone,
 *      build, or config needed), or
 *   2) for an unrecognized subdirectory of *some* monorepo, clones the repo
 *      root and cd's into the correct subpath (still correct, just less
 *      convenient than an npx/uvx one-liner).
 * A plain repository URL (no /tree/ subpath) falls back to the previous
 * clone + build flow, which is unaffected by this bug and still applies to
 * MCP Everything's own generated/hosted servers.
 */

export interface InstallCommandServer {
  name: string;
  slug: string;
  repositoryUrl?: string;
  gistUrl?: string;
}

type Runtime = 'npx' | 'uvx';

interface ReferenceServerPackage {
  runtime: Runtime;
  /** Real published package name (npm scope or PyPI project name). */
  package: string;
  /** Required/typical CLI args, as user-fillable placeholders. */
  args?: string[];
  /**
   * `uv`/pip version constraint(s) to force via `uvx --with`, e.g. `mcp<2`.
   * Verified live (2026-08) that all three PyPI reference servers
   * (mcp-server-fetch/-git/-time) are currently broken when uv resolves the
   * latest `mcp` (2.0.0) - `mcp.shared.exceptions.McpError` was removed and
   * `Server.list_tools` was renamed upstream, and none of these packages pin
   * an upper bound themselves. Without this, the "documented" `uvx <pkg>`
   * command intermittently breaks the moment the `mcp` package gets a new
   * major release, independent of anything in this codebase.
   */
  pinConstraint?: string;
}

/**
 * Verified against the actual npm/PyPI registries and the servers'
 * documented `mcpServers` config (2026-08) - see PR description for the
 * terminal output of each command actually being run. Package names don't
 * derive cleanly from the directory name (e.g. "sequentialthinking" ->
 * "@modelcontextprotocol/server-sequential-thinking"), so this is an
 * explicit table rather than a naming convention.
 */
const KNOWN_REFERENCE_SERVER_PACKAGES: Record<string, ReferenceServerPackage> = {
  filesystem: {
    runtime: 'npx',
    package: '@modelcontextprotocol/server-filesystem',
    args: ['<allowed-directory>'],
  },
  fetch: {
    runtime: 'uvx',
    package: 'mcp-server-fetch',
    pinConstraint: 'mcp<2',
  },
  git: {
    runtime: 'uvx',
    package: 'mcp-server-git',
    args: ['--repository', '<path-to-git-repo>'],
    pinConstraint: 'mcp<2',
  },
  memory: {
    runtime: 'npx',
    package: '@modelcontextprotocol/server-memory',
  },
  sequentialthinking: {
    runtime: 'npx',
    package: '@modelcontextprotocol/server-sequential-thinking',
  },
  time: {
    runtime: 'uvx',
    package: 'mcp-server-time',
    args: ['--local-timezone', '<IANA timezone, e.g. America/New_York>'],
    pinConstraint: 'mcp<2',
  },
};

/** Matches e.g. https://github.com/modelcontextprotocol/servers/tree/main/src/fetch */
const GITHUB_TREE_URL_RE = /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/tree\/([^/]+)\/(.+?)\/?$/;

function mcpClientConfigSnippet(slug: string, command: string, args: string[]): string {
  const argsJson = args.map((a) => `"${a}"`).join(', ');
  return [
    '# Then add it to your MCP client config (e.g. claude_desktop_config.json):',
    '# "mcpServers": {',
    `#   "${slug}": { "command": "${command}", "args": [${argsJson}] }`,
    '# }',
  ].join('\n');
}

function commandForReferencePackage(pkg: ReferenceServerPackage): string {
  const args = pkg.args ?? [];
  const argsSuffix = args.length ? ' ' + args.join(' ') : '';
  if (pkg.runtime === 'npx') {
    return `npx -y ${pkg.package}${argsSuffix}`;
  }
  const withSuffix = pkg.pinConstraint ? ` --with "${pkg.pinConstraint}"` : '';
  return `uvx${withSuffix} ${pkg.package}${argsSuffix}`;
}

export function buildInstallCommand(server: InstallCommandServer | null | undefined): string {
  if (!server) return '';

  const repoTreeMatch = server.repositoryUrl?.match(GITHUB_TREE_URL_RE);
  if (repoTreeMatch) {
    const [, owner, repo, branch, subPath] = repoTreeMatch;
    const dirName = subPath.split('/').pop() ?? '';
    const isOfficialServersMonorepo =
      owner.toLowerCase() === 'modelcontextprotocol' && repo.toLowerCase() === 'servers';
    const known = isOfficialServersMonorepo ? KNOWN_REFERENCE_SERVER_PACKAGES[dirName] : undefined;

    if (known) {
      const runCommand = commandForReferencePackage(known);
      const args = known.args ?? [];
      const fullArgs =
        known.runtime === 'npx'
          ? ['-y', known.package, ...args]
          : [...(known.pinConstraint ? ['--with', known.pinConstraint] : []), known.package, ...args];
      return [
        `# "${server.name}" is published as ${known.package} - no clone required.`,
        runCommand,
        '',
        mcpClientConfigSnippet(server.slug, known.runtime, fullArgs),
      ].join('\n');
    }

    // Unknown subdirectory of a monorepo: a plain clone of the tree URL is
    // not a valid remote, so clone the repo root (at the referenced branch)
    // and cd into the real subpath.
    return [
      `# "${server.name}" lives in a subdirectory of the ${owner}/${repo} repo, not its own repo.`,
      `git clone --branch ${branch} https://github.com/${owner}/${repo}.git`,
      `cd ${repo}/${subPath}`,
      '# See this subdirectory\'s own README for build/run instructions (they vary per package).',
    ].join('\n');
  }

  const sourceUrl = server.repositoryUrl || server.gistUrl;
  if (sourceUrl) {
    const folderName =
      sourceUrl.replace(/\.git$/, '').replace(/\/+$/, '').split('/').pop() || server.slug;
    return [
      `git clone ${sourceUrl}`,
      `cd ${folderName}`,
      'npm install && npm run build',
      '',
      mcpClientConfigSnippet(server.slug, 'node', [`${folderName}/dist/index.js`]),
    ].join('\n');
  }

  return `# Source for "${server.name}" is not published yet - no install command available.`;
}
