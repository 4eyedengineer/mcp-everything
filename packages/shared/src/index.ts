// Shared types and utilities export barrel

// Types
export * from './types/mcp-server.types';
export * from './types/api.types';
export * from './types/entities.types';

// Utilities (to be added later)
// export * from './utils/validation';
// export * from './utils/formatting';

// Constants
export const API_ENDPOINTS = {
  GITHUB: {
    ANALYZE: '/api/github/analyze',
    REPOSITORIES: '/api/github/repositories',
  },
  GENERATION: {
    GENERATE: '/api/generation/generate',
    STATUS: '/api/generation/status',
    HISTORY: '/api/generation/history',
  },
  SERVERS: {
    LIST: '/api/servers',
    DETAILS: '/api/servers/:id',
    UPDATE: '/api/servers/:id',
    DELETE: '/api/servers/:id',
    DEPLOY: '/api/servers/:id/deploy',
    LOGS: '/api/servers/:id/logs',
  },
  DEPLOYMENT: {
    GIST: '/api/deployment/gist',
    REPO: '/api/deployment/repo',
    VERCEL: '/api/deployment/vercel',
  },
} as const;

export const MCP_SERVER_STATUSES = {
  DRAFT: 'draft',
  GENERATING: 'generating',
  BUILDING: 'building',
  VALIDATING: 'validating',
  DEPLOYING: 'deploying',
  ACTIVE: 'active',
  ERROR: 'error',
  ARCHIVED: 'archived',
} as const;

export const GENERATION_STATUSES = {
  PENDING: 'pending',
  ANALYZING: 'analyzing',
  GENERATING: 'generating',
  BUILDING: 'building',
  VALIDATING: 'validating',
  COMPLETED: 'completed',
  FAILED: 'failed',
} as const;