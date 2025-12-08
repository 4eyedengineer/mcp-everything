/**
 * MCP Server Categories
 *
 * Standard categories for organizing MCP servers in the marketplace.
 * These categories help users discover servers by their primary function.
 */

export const MCP_SERVER_CATEGORIES = {
  api: {
    name: 'API Integrations',
    description: 'MCP servers that integrate with external APIs',
    examples: ['Stripe', 'GitHub', 'Slack', 'Twilio'],
  },
  database: {
    name: 'Database Connectors',
    description: 'MCP servers for database operations',
    examples: ['PostgreSQL', 'MongoDB', 'Redis', 'MySQL'],
  },
  utility: {
    name: 'Utility Tools',
    description: 'General-purpose utility MCP servers',
    examples: ['File System', 'Shell Commands', 'JSON Processing'],
  },
  ai: {
    name: 'AI & ML',
    description: 'AI and machine learning integrations',
    examples: ['OpenAI', 'Hugging Face', 'LangChain'],
  },
  devtools: {
    name: 'Developer Tools',
    description: 'Tools for software development workflows',
    examples: ['Git', 'Docker', 'CI/CD', 'Testing'],
  },
  communication: {
    name: 'Communication',
    description: 'Email, chat, and notification services',
    examples: ['Email (SendGrid)', 'Discord', 'Teams'],
  },
  storage: {
    name: 'Storage',
    description: 'File storage and cloud storage services',
    examples: ['S3', 'Google Cloud Storage', 'Dropbox'],
  },
  analytics: {
    name: 'Analytics',
    description: 'Analytics and monitoring services',
    examples: ['Google Analytics', 'Mixpanel', 'Amplitude'],
  },
  other: {
    name: 'Other',
    description: 'Miscellaneous MCP servers',
    examples: [],
  },
} as const;

/**
 * Type for valid category keys
 */
export type McpServerCategory = keyof typeof MCP_SERVER_CATEGORIES;

/**
 * Array of all valid category keys for validation
 */
export const VALID_CATEGORIES: McpServerCategory[] = Object.keys(
  MCP_SERVER_CATEGORIES,
) as McpServerCategory[];

/**
 * MCP Server Status
 */
export type McpServerStatus = 'pending' | 'approved' | 'rejected' | 'archived';

export const MCP_SERVER_STATUSES: McpServerStatus[] = [
  'pending',
  'approved',
  'rejected',
  'archived',
];

/**
 * MCP Server Visibility
 */
export type McpServerVisibility = 'public' | 'private' | 'unlisted';

export const MCP_SERVER_VISIBILITIES: McpServerVisibility[] = [
  'public',
  'private',
  'unlisted',
];

/**
 * MCP Server Language
 */
export type McpServerLanguage = 'typescript' | 'python' | 'javascript';

export const MCP_SERVER_LANGUAGES: McpServerLanguage[] = [
  'typescript',
  'python',
  'javascript',
];
