import {
  McpServerCategory,
  McpServerVisibility,
  McpServerStatus,
  McpServerLanguage,
} from '../types/categories';

export interface McpToolResponse {
  name: string;
  description: string;
  inputSchema?: Record<string, unknown>;
}

export interface McpResourceResponse {
  uri: string;
  name: string;
  description: string;
}

export interface AuthorResponse {
  id: string;
  firstName?: string;
  lastName?: string;
  githubUsername?: string;
}

export interface ServerResponse {
  id: string;
  name: string;
  slug: string;
  description: string;
  longDescription?: string;
  category: McpServerCategory;
  tags?: string[];
  visibility: McpServerVisibility;
  author?: AuthorResponse;
  repositoryUrl?: string;
  gistUrl?: string;
  downloadUrl?: string;
  tools?: McpToolResponse[];
  resources?: McpResourceResponse[];
  envVars?: string[];
  language: McpServerLanguage;
  downloadCount: number;
  viewCount: number;
  rating: number;
  ratingCount: number;
  status: McpServerStatus;
  featured: boolean;
  sourceConversationId?: string;
  metadata?: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
  publishedAt?: Date;
}

export interface ServerSummaryResponse {
  id: string;
  name: string;
  slug: string;
  description: string;
  category: McpServerCategory;
  tags?: string[];
  author?: AuthorResponse;
  downloadCount: number;
  rating: number;
  ratingCount: number;
  featured: boolean;
  language: McpServerLanguage;
  createdAt: Date;
}

export interface CategoryResponse {
  key: string;
  name: string;
  description: string;
  examples: readonly string[];
  serverCount?: number;
}
