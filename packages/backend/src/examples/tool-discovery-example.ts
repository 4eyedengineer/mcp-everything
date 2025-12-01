/**
 * Tool Discovery Service Usage Examples
 *
 * This file demonstrates how to use the AI-powered tool discovery service
 * to generate repository-specific MCP tools.
 */

import { ToolDiscoveryService } from '../tool-discovery.service';
import { GitHubAnalysisService } from '../github-analysis.service';
import { ConversationService } from '../conversation.service';

// Example usage patterns for the Tool Discovery Service

/**
 * Example 1: Discover tools for a React component library
 */
export async function discoverReactLibraryTools() {
  // Mock repository analysis for a React component library
  const reactLibraryAnalysis = {
    metadata: {
      name: 'awesome-react-components',
      fullName: 'company/awesome-react-components',
      description: 'A collection of reusable React components',
      language: 'TypeScript',
      size: 5000,
      stargazersCount: 1200,
      forksCount: 150,
      topics: ['react', 'components', 'typescript', 'ui'],
      license: 'MIT',
      defaultBranch: 'main',
      createdAt: '2023-01-01T00:00:00Z',
      updatedAt: '2024-09-22T00:00:00Z',
      homepage: 'https://awesome-react-components.dev'
    },
    techStack: {
      languages: ['TypeScript', 'JavaScript'],
      frameworks: ['React', 'Storybook'],
      tools: ['Webpack', 'Jest', 'ESLint'],
      confidence: 0.95
    },
    features: {
      hasApi: false,
      hasCli: true,
      hasDatabase: false,
      hasTests: true,
      hasDocumentation: true,
      hasDocker: false,
      hasCi: true
    },
    sourceFiles: [
      {
        path: 'src/components/Button/Button.tsx',
        content: `
import React from 'react';
import { ButtonProps } from './Button.types';

export const Button: React.FC<ButtonProps> = ({
  children,
  variant = 'primary',
  size = 'medium',
  disabled = false,
  onClick,
  ...props
}) => {
  return (
    <button
      className={\`btn btn-\${variant} btn-\${size}\`}
      disabled={disabled}
      onClick={onClick}
      {...props}
    >
      {children}
    </button>
  );
};
        `,
        size: 500,
        type: 'main',
        language: 'TypeScript'
      }
    ]
  };

  // Expected discovered tools for React library:
  const expectedTools = [
    {
      name: 'analyze_component',
      description: 'Analyze React component structure, props, and TypeScript interfaces',
      category: 'analysis',
      quality: { overallScore: 0.85 }
    },
    {
      name: 'extract_component_props',
      description: 'Extract and document component props with TypeScript types',
      category: 'documentation',
      quality: { overallScore: 0.82 }
    },
    {
      name: 'generate_storybook_story',
      description: 'Generate Storybook stories for components automatically',
      category: 'build',
      quality: { overallScore: 0.78 }
    },
    {
      name: 'validate_component_usage',
      description: 'Check component usage patterns across the codebase',
      category: 'analysis',
      quality: { overallScore: 0.75 }
    }
  ];

  return { analysis: reactLibraryAnalysis, expectedTools };
}

/**
 * Example 2: Discover tools for a REST API service
 */
export async function discoverApiServiceTools() {
  const apiServiceAnalysis = {
    metadata: {
      name: 'user-management-api',
      fullName: 'company/user-management-api',
      description: 'RESTful API for user management and authentication',
      language: 'JavaScript',
      // ... other metadata
    },
    techStack: {
      languages: ['JavaScript'],
      frameworks: ['Express.js', 'Mongoose'],
      databases: ['MongoDB'],
      tools: ['Docker', 'Jest', 'Swagger'],
      confidence: 0.92
    },
    apiPatterns: [
      {
        type: 'REST',
        endpoints: ['/api/users', '/api/auth/login', '/api/auth/register'],
        methods: ['GET', 'POST', 'PUT', 'DELETE'],
        patterns: ['CRUD operations', 'JWT authentication'],
        confidence: 0.9
      }
    ],
    features: {
      hasApi: true,
      hasDatabase: true,
      hasTests: true,
      hasDocumentation: true
    }
  };

  // Expected tools for API service:
  const expectedTools = [
    {
      name: 'call_user_endpoint',
      description: 'Make authenticated calls to user management endpoints',
      category: 'api',
      inputSchema: {
        type: 'object',
        properties: {
          endpoint: { type: 'string', description: 'API endpoint path' },
          method: { type: 'string', enum: ['GET', 'POST', 'PUT', 'DELETE'] },
          token: { type: 'string', description: 'JWT authentication token' },
          data: { type: 'object', description: 'Request payload' }
        },
        required: ['endpoint', 'method']
      }
    },
    {
      name: 'validate_user_data',
      description: 'Validate user data against API schema requirements',
      category: 'utility',
      quality: { overallScore: 0.8 }
    },
    {
      name: 'generate_test_users',
      description: 'Generate test user data for API testing',
      category: 'test',
      quality: { overallScore: 0.75 }
    }
  ];

  return { analysis: apiServiceAnalysis, expectedTools };
}

/**
 * Example 3: Discover tools for a CLI utility
 */
export async function discoverCliToolsExample() {
  const cliToolAnalysis = {
    metadata: {
      name: 'deploy-helper',
      fullName: 'company/deploy-helper',
      description: 'Command-line tool for deployment automation',
      language: 'Python',
    },
    techStack: {
      languages: ['Python'],
      frameworks: ['Click', 'PyYAML'],
      tools: ['Docker', 'Kubernetes'],
      confidence: 0.88
    },
    features: {
      hasCli: true,
      hasDocker: true,
      hasTests: true
    },
    readme: {
      content: `
# Deploy Helper

A command-line tool for automating deployments.

## Commands

- \`deploy-helper init\` - Initialize deployment configuration
- \`deploy-helper deploy <environment>\` - Deploy to specified environment
- \`deploy-helper rollback <version>\` - Rollback to previous version
- \`deploy-helper status\` - Check deployment status

## Configuration

Create a \`deploy.yaml\` file with your deployment settings.
      `,
      extractedFeatures: ['CLI commands', 'YAML configuration', 'deployment automation']
    }
  };

  // Expected tools for CLI utility:
  const expectedTools = [
    {
      name: 'run_deployment',
      description: 'Execute deployment commands with specified environment and options',
      category: 'utility',
      inputSchema: {
        type: 'object',
        properties: {
          environment: { type: 'string', description: 'Target environment (dev, staging, prod)' },
          version: { type: 'string', description: 'Version to deploy' },
          dryRun: { type: 'boolean', description: 'Perform dry run without actual deployment' }
        },
        required: ['environment']
      }
    },
    {
      name: 'validate_deploy_config',
      description: 'Validate deployment configuration YAML file',
      category: 'utility',
      quality: { overallScore: 0.82 }
    },
    {
      name: 'check_deployment_status',
      description: 'Check the status of current deployments across environments',
      category: 'utility',
      quality: { overallScore: 0.79 }
    }
  ];

  return { analysis: cliToolAnalysis, expectedTools };
}

/**
 * Example 4: Integration with actual Tool Discovery Service
 */
export async function runToolDiscoveryExample(
  toolDiscoveryService: ToolDiscoveryService,
  repositoryUrl: string
) {
  try {
    console.log(`Discovering tools for: ${repositoryUrl}`);

    // Note: This would require GitHubAnalysisService to get the analysis first
    // const analysis = await githubAnalysisService.analyzeRepository(repositoryUrl);
    // const result = await toolDiscoveryService.discoverTools(analysis);

    console.log('Tool discovery completed successfully');
    // console.log(`Discovered ${result.tools.length} tools`);
    // return result;

  } catch (error) {
    console.error('Tool discovery failed:', error.message);
    throw error;
  }
}

/**
 * Example 5: Quality threshold testing
 */
export function demonstrateQualityThresholds() {
  const qualityExamples = [
    {
      toolName: 'analyze_react_hooks',
      quality: {
        usefulness: 0.9,      // Very useful for React developers
        specificity: 0.85,    // Highly specific to React
        implementability: 0.8, // Reasonably feasible
        uniqueness: 0.75,     // Somewhat unique
        overallScore: 0.825,  // Above threshold (0.7)
        reasoning: 'Highly useful React-specific tool with good implementation feasibility'
      },
      wouldPass: true
    },
    {
      toolName: 'generic_file_reader',
      quality: {
        usefulness: 0.6,      // Somewhat useful
        specificity: 0.2,     // Very generic
        implementability: 0.9, // Easy to implement
        uniqueness: 0.1,      // Not unique at all
        overallScore: 0.45,   // Below threshold (0.7)
        reasoning: 'Too generic, not repository-specific enough'
      },
      wouldPass: false
    },
    {
      toolName: 'validate_api_schema',
      quality: {
        usefulness: 0.85,     // Very useful for API projects
        specificity: 0.7,     // API-specific
        implementability: 0.75, // Moderately complex
        uniqueness: 0.6,      // Reasonably unique
        overallScore: 0.725,  // Just above threshold
        reasoning: 'Good API-specific tool with practical value'
      },
      wouldPass: true
    }
  ];

  return qualityExamples;
}

/**
 * Example 6: Category distribution examples
 */
export function demonstrateCategoryDistribution() {
  return {
    'data': [
      'extract_user_data',
      'parse_config_files',
      'aggregate_metrics'
    ],
    'api': [
      'call_rest_endpoint',
      'authenticate_user',
      'validate_response'
    ],
    'analysis': [
      'analyze_code_quality',
      'detect_patterns',
      'measure_complexity'
    ],
    'utility': [
      'format_output',
      'validate_input',
      'generate_ids'
    ],
    'build': [
      'run_tests',
      'build_docker_image',
      'deploy_service'
    ]
  };
}

// Export all examples for testing and demonstration
export const toolDiscoveryExamples = {
  discoverReactLibraryTools,
  discoverApiServiceTools,
  discoverCliToolsExample,
  runToolDiscoveryExample,
  demonstrateQualityThresholds,
  demonstrateCategoryDistribution
};