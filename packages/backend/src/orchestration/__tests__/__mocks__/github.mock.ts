/**
 * Mock for GitHub API and Analysis Service
 *
 * Provides mock implementations for GitHub repository analysis
 * used in research phase without making real API calls.
 */

export const mockGitHubAnalysisResult = {
  metadata: {
    name: 'test-repo',
    description: 'A test repository for MCP server generation',
    language: 'TypeScript',
    stargazersCount: 1500,
    topics: ['api', 'sdk', 'typescript'],
  },
  readme: {
    content: `# Test Repo

A comprehensive SDK for testing purposes.

## Installation

\`\`\`bash
npm install test-repo
\`\`\`

## API Reference

### Authentication

Use API keys for authentication:

\`\`\`typescript
const client = new TestClient({ apiKey: 'your-key' });
\`\`\`

### Endpoints

- GET /users - List users
- POST /users - Create user
- GET /users/:id - Get user by ID
`,
  },
  apiPatterns: [
    {
      type: 'REST',
      endpoints: ['/users', '/users/:id', '/products', '/orders'],
    },
  ],
  sourceFiles: [
    {
      path: 'src/client.ts',
      language: 'typescript',
      content: `
export class TestClient {
  private apiKey: string;
  private baseUrl = 'https://api.test.com/v1';

  constructor(config: { apiKey: string }) {
    this.apiKey = config.apiKey;
  }

  async getUsers() {
    return fetch(\`\${this.baseUrl}/users\`, {
      headers: { 'Authorization': \`Bearer \${this.apiKey}\` }
    });
  }
}
`,
    },
  ],
};

export const mockCodeExamples = [
  {
    file: 'examples/basic.ts',
    content: `
const client = new TestClient({ apiKey: process.env.API_KEY });
const users = await client.getUsers();
console.log(users);
`,
    language: 'typescript',
  },
  {
    file: 'src/index.ts',
    content: `
export { TestClient } from './client';
export type { User, Product } from './types';
`,
    language: 'typescript',
  },
];

export const mockTestPatterns = [
  {
    framework: 'jest',
    pattern: 'describe-it',
    examples: ['describe("Client", () => { it("should work", () => {}); })'],
  },
];

export const mockApiUsagePatterns = [
  {
    endpoint: '/users',
    method: 'GET',
    parameters: {},
    exampleUsage: 'client.getUsers()',
  },
  {
    endpoint: '/users/:id',
    method: 'GET',
    parameters: { id: 'string' },
    exampleUsage: 'client.getUser(id)',
  },
  {
    endpoint: '/users',
    method: 'POST',
    parameters: { name: 'string', email: 'string' },
    exampleUsage: 'client.createUser({ name, email })',
  },
];

export const createMockGitHubAnalysisService = () => ({
  analyzeRepository: jest.fn().mockResolvedValue(mockGitHubAnalysisResult),
  extractCodeExamples: jest.fn().mockResolvedValue(mockCodeExamples),
  analyzeTestPatterns: jest.fn().mockResolvedValue(mockTestPatterns),
  extractApiUsagePatterns: jest.fn().mockResolvedValue(mockApiUsagePatterns),
});

export const mockOctokitSearchReposResponse = {
  data: {
    items: [
      {
        html_url: 'https://github.com/stripe/stripe-node',
        stargazers_count: 35000,
        full_name: 'stripe/stripe-node',
      },
      {
        html_url: 'https://github.com/stripe/stripe-python',
        stargazers_count: 15000,
        full_name: 'stripe/stripe-python',
      },
    ],
  },
};

export const createMockOctokit = () => ({
  search: {
    repos: jest.fn().mockResolvedValue(mockOctokitSearchReposResponse),
  },
  repos: {
    get: jest.fn().mockResolvedValue({
      data: {
        name: 'test-repo',
        description: 'A test repository',
        language: 'TypeScript',
        stargazers_count: 1500,
        topics: ['api', 'sdk'],
      },
    }),
    getContent: jest.fn().mockResolvedValue({
      data: {
        content: Buffer.from('# README').toString('base64'),
        encoding: 'base64',
      },
    }),
  },
});
