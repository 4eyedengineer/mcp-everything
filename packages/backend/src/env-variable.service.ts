import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Octokit } from '@octokit/rest';
import * as sodium from 'libsodium-wrappers';
import {
  RequiredEnvVar,
  EnvVarCategory,
  ApiKeyPattern,
  EnvVarValidationResult,
  EnvVarDetectionResult,
  GitHubSecretRequest,
  GitHubSecretResult,
  CollectedEnvVar,
} from './types/env-variable.types';
import { McpTool, ImplementationHints } from './types/tool-discovery.types';

/**
 * Environment Variable Service
 *
 * Handles detection, validation, and secure storage of environment variables
 * for generated MCP servers.
 *
 * Key responsibilities:
 * - Detect required API keys from tool descriptions and implementation hints
 * - Validate API key formats for common services
 * - Generate .env.example files with placeholders
 * - Create GitHub repository secrets via API
 * - Provide documentation URLs for obtaining keys
 */
@Injectable()
export class EnvVariableService {
  private readonly logger = new Logger(EnvVariableService.name);
  private readonly octokit: Octokit;

  /**
   * Known API key patterns for common services
   * Used for detection and validation
   */
  private readonly knownPatterns: ApiKeyPattern[] = [
    // Payment Services
    {
      service: 'Stripe',
      envVarName: 'STRIPE_API_KEY',
      validationPattern: /^sk_(test|live)_[a-zA-Z0-9]{24,}$/,
      formatDescription: 'Starts with sk_test_ or sk_live_ followed by alphanumeric characters',
      documentationUrl: 'https://dashboard.stripe.com/apikeys',
      category: 'payment',
      examplePlaceholder: 'sk_test_xxxxxxxxxxxxxxxxxxxx',
    },
    {
      service: 'Stripe',
      envVarName: 'STRIPE_PUBLISHABLE_KEY',
      validationPattern: /^pk_(test|live)_[a-zA-Z0-9]{24,}$/,
      formatDescription: 'Starts with pk_test_ or pk_live_ followed by alphanumeric characters',
      documentationUrl: 'https://dashboard.stripe.com/apikeys',
      category: 'payment',
      examplePlaceholder: 'pk_test_xxxxxxxxxxxxxxxxxxxx',
    },
    {
      service: 'Stripe',
      envVarName: 'STRIPE_WEBHOOK_SECRET',
      validationPattern: /^whsec_[a-zA-Z0-9]{24,}$/,
      formatDescription: 'Starts with whsec_ followed by alphanumeric characters',
      documentationUrl: 'https://dashboard.stripe.com/webhooks',
      category: 'payment',
      examplePlaceholder: 'whsec_xxxxxxxxxxxxxxxxxxxx',
    },

    // AI Services
    {
      service: 'OpenAI',
      envVarName: 'OPENAI_API_KEY',
      validationPattern: /^sk-[a-zA-Z0-9]{32,}$/,
      formatDescription: 'Starts with sk- followed by alphanumeric characters',
      documentationUrl: 'https://platform.openai.com/api-keys',
      category: 'ai',
      examplePlaceholder: 'sk-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
    },
    {
      service: 'Anthropic',
      envVarName: 'ANTHROPIC_API_KEY',
      validationPattern: /^sk-ant-[a-zA-Z0-9-]{32,}$/,
      formatDescription: 'Starts with sk-ant- followed by alphanumeric characters',
      documentationUrl: 'https://console.anthropic.com/settings/keys',
      category: 'ai',
      examplePlaceholder: 'sk-ant-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
    },

    // Cloud Services
    {
      service: 'AWS',
      envVarName: 'AWS_ACCESS_KEY_ID',
      validationPattern: /^AKIA[A-Z0-9]{16}$/,
      formatDescription: 'Starts with AKIA followed by 16 uppercase alphanumeric characters',
      documentationUrl: 'https://docs.aws.amazon.com/IAM/latest/UserGuide/id_credentials_access-keys.html',
      category: 'cloud',
      examplePlaceholder: 'AKIAXXXXXXXXXXXXXXXX',
    },
    {
      service: 'AWS',
      envVarName: 'AWS_SECRET_ACCESS_KEY',
      validationPattern: /^[a-zA-Z0-9/+=]{40}$/,
      formatDescription: '40 character secret key',
      documentationUrl: 'https://docs.aws.amazon.com/IAM/latest/UserGuide/id_credentials_access-keys.html',
      category: 'cloud',
      examplePlaceholder: 'xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
    },

    // Database
    {
      service: 'MongoDB',
      envVarName: 'MONGODB_URI',
      validationPattern: /^mongodb(\+srv)?:\/\/.+/,
      formatDescription: 'MongoDB connection string starting with mongodb:// or mongodb+srv://',
      documentationUrl: 'https://www.mongodb.com/docs/manual/reference/connection-string/',
      category: 'database',
      examplePlaceholder: 'mongodb+srv://username:password@cluster.mongodb.net/database',
    },
    {
      service: 'PostgreSQL',
      envVarName: 'DATABASE_URL',
      validationPattern: /^postgres(ql)?:\/\/.+/,
      formatDescription: 'PostgreSQL connection string starting with postgres:// or postgresql://',
      documentationUrl: 'https://www.postgresql.org/docs/current/libpq-connect.html#LIBPQ-CONNSTRING',
      category: 'database',
      examplePlaceholder: 'postgresql://username:password@host:5432/database',
    },

    // Messaging
    {
      service: 'Twilio',
      envVarName: 'TWILIO_ACCOUNT_SID',
      validationPattern: /^AC[a-f0-9]{32}$/,
      formatDescription: 'Starts with AC followed by 32 hexadecimal characters',
      documentationUrl: 'https://www.twilio.com/docs/iam/credentials/api',
      category: 'messaging',
      examplePlaceholder: 'ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
    },
    {
      service: 'Twilio',
      envVarName: 'TWILIO_AUTH_TOKEN',
      validationPattern: /^[a-f0-9]{32}$/,
      formatDescription: '32 hexadecimal character auth token',
      documentationUrl: 'https://www.twilio.com/docs/iam/credentials/api',
      category: 'messaging',
      examplePlaceholder: 'xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
    },
    {
      service: 'SendGrid',
      envVarName: 'SENDGRID_API_KEY',
      validationPattern: /^SG\.[a-zA-Z0-9_-]{22}\.[a-zA-Z0-9_-]{43}$/,
      formatDescription: 'Starts with SG. followed by two base64-encoded segments',
      documentationUrl: 'https://docs.sendgrid.com/ui/account-and-settings/api-keys',
      category: 'messaging',
      examplePlaceholder: 'SG.xxxxxxxxxxxxxxxxxxxx.xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
    },

    // Authentication
    {
      service: 'GitHub',
      envVarName: 'GITHUB_TOKEN',
      validationPattern: /^(ghp|gho|ghu|ghs|ghr)_[a-zA-Z0-9]{36,}$/,
      formatDescription: 'GitHub personal access token starting with ghp_, gho_, ghu_, ghs_, or ghr_',
      documentationUrl: 'https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/creating-a-personal-access-token',
      category: 'authentication',
      examplePlaceholder: 'ghp_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
    },

    // Analytics
    {
      service: 'Google Analytics',
      envVarName: 'GA_MEASUREMENT_ID',
      validationPattern: /^G-[A-Z0-9]{10}$/,
      formatDescription: 'Google Analytics 4 measurement ID starting with G-',
      documentationUrl: 'https://support.google.com/analytics/answer/9539598',
      category: 'analytics',
      examplePlaceholder: 'G-XXXXXXXXXX',
    },
  ];

  /**
   * Keywords that indicate an environment variable might be needed
   */
  private readonly envVarKeywords: Record<string, EnvVarCategory> = {
    // Authentication keywords
    'api key': 'authentication',
    'api_key': 'authentication',
    'apikey': 'authentication',
    'secret key': 'authentication',
    'secret_key': 'authentication',
    'access token': 'authentication',
    'access_token': 'authentication',
    'bearer token': 'authentication',
    'auth token': 'authentication',
    'oauth': 'authentication',

    // Database keywords
    'database': 'database',
    'connection string': 'database',
    'mongodb': 'database',
    'postgres': 'database',
    'mysql': 'database',
    'redis': 'database',

    // Payment keywords
    'stripe': 'payment',
    'payment': 'payment',
    'billing': 'payment',

    // AI keywords
    'openai': 'ai',
    'anthropic': 'ai',
    'claude': 'ai',
    'gpt': 'ai',

    // Cloud keywords
    'aws': 'cloud',
    's3': 'cloud',
    'gcp': 'cloud',
    'azure': 'cloud',

    // Messaging keywords
    'twilio': 'messaging',
    'sendgrid': 'messaging',
    'smtp': 'messaging',
    'email': 'messaging',
  };

  constructor(private readonly configService: ConfigService) {
    const githubToken = this.configService.get<string>('GITHUB_TOKEN');
    this.octokit = new Octokit({
      auth: githubToken,
    });
  }

  /**
   * Detect required environment variables from discovered tools
   *
   * Analyzes tool descriptions, implementation hints, and required data
   * to identify API keys and secrets that will be needed.
   */
  async detectRequiredEnvVars(tools: McpTool[]): Promise<EnvVarDetectionResult> {
    this.logger.log(`Detecting environment variables from ${tools.length} tools`);

    const detectedVars: RequiredEnvVar[] = [];
    const seenNames = new Set<string>();

    for (const tool of tools) {
      // Check tool description
      const descriptionVars = this.extractEnvVarsFromText(tool.description);
      for (const envVar of descriptionVars) {
        if (!seenNames.has(envVar.name)) {
          detectedVars.push(envVar);
          seenNames.add(envVar.name);
        }
      }

      // Check implementation hints
      if (tool.implementationHints) {
        const hintsVars = this.extractEnvVarsFromHints(tool.implementationHints);
        for (const envVar of hintsVars) {
          if (!seenNames.has(envVar.name)) {
            detectedVars.push(envVar);
            seenNames.add(envVar.name);
          }
        }
      }
    }

    const result: EnvVarDetectionResult = {
      detectedVars,
      detectionMethod: 'tool_analysis',
      confidence: detectedVars.length > 0 ? 0.8 : 1.0,
      reasoning: detectedVars.length > 0
        ? `Detected ${detectedVars.length} environment variable(s) based on tool descriptions and implementation hints`
        : 'No environment variables detected from tool analysis',
    };

    this.logger.log(`Detected ${detectedVars.length} environment variables`);
    return result;
  }

  /**
   * Extract environment variables from text (description, hints, etc.)
   */
  private extractEnvVarsFromText(text: string): RequiredEnvVar[] {
    const envVars: RequiredEnvVar[] = [];
    const lowerText = text.toLowerCase();

    // Check for known service patterns
    for (const pattern of this.knownPatterns) {
      const serviceLower = pattern.service.toLowerCase();
      if (lowerText.includes(serviceLower)) {
        envVars.push({
          name: pattern.envVarName,
          description: `${pattern.service} ${this.getCategoryDescription(pattern.category)}`,
          required: true,
          format: pattern.validationPattern.source,
          documentationUrl: pattern.documentationUrl,
          category: pattern.category,
          sensitive: true,
        });
      }
    }

    // Check for generic keywords
    for (const [keyword, category] of Object.entries(this.envVarKeywords)) {
      if (lowerText.includes(keyword) && !envVars.some(v => v.category === category)) {
        const envVarName = this.generateEnvVarName(keyword, category);
        if (!envVars.some(v => v.name === envVarName)) {
          envVars.push({
            name: envVarName,
            description: `${this.capitalizeFirst(keyword)} credential`,
            required: true,
            category,
            sensitive: true,
          });
        }
      }
    }

    return envVars;
  }

  /**
   * Extract environment variables from implementation hints
   */
  private extractEnvVarsFromHints(hints: ImplementationHints): RequiredEnvVar[] {
    const envVars: RequiredEnvVar[] = [];

    // Check requiredData for API key mentions
    for (const data of hints.requiredData) {
      const extracted = this.extractEnvVarsFromText(data);
      envVars.push(...extracted);
    }

    // Check dependencies for known services
    for (const dep of hints.dependencies) {
      const depLower = dep.toLowerCase();

      // Check if dependency corresponds to a known service
      if (depLower.includes('stripe')) {
        const stripePattern = this.knownPatterns.find(p => p.envVarName === 'STRIPE_API_KEY');
        if (stripePattern && !envVars.some(v => v.name === stripePattern.envVarName)) {
          envVars.push({
            name: stripePattern.envVarName,
            description: 'Stripe API key for payment processing',
            required: true,
            format: stripePattern.validationPattern.source,
            documentationUrl: stripePattern.documentationUrl,
            category: 'payment',
            sensitive: true,
          });
        }
      }

      if (depLower.includes('openai')) {
        const openaiPattern = this.knownPatterns.find(p => p.envVarName === 'OPENAI_API_KEY');
        if (openaiPattern && !envVars.some(v => v.name === openaiPattern.envVarName)) {
          envVars.push({
            name: openaiPattern.envVarName,
            description: 'OpenAI API key for AI services',
            required: true,
            format: openaiPattern.validationPattern.source,
            documentationUrl: openaiPattern.documentationUrl,
            category: 'ai',
            sensitive: true,
          });
        }
      }
    }

    return envVars;
  }

  /**
   * Validate an environment variable value against known patterns
   */
  validateEnvVarFormat(name: string, value: string): EnvVarValidationResult {
    // Find matching pattern
    const pattern = this.knownPatterns.find(p => p.envVarName === name);

    if (!pattern) {
      // Unknown variable - basic validation
      if (!value || value.trim().length === 0) {
        return {
          isValid: false,
          errorMessage: 'Value cannot be empty',
        };
      }
      return { isValid: true };
    }

    // Validate against known pattern
    const isValid = pattern.validationPattern.test(value);

    if (!isValid) {
      return {
        isValid: false,
        errorMessage: `Invalid format for ${pattern.service}. ${pattern.formatDescription}`,
        suggestions: [
          `Get your ${pattern.service} key from: ${pattern.documentationUrl}`,
          `Expected format: ${pattern.examplePlaceholder}`,
        ],
      };
    }

    // Check if it's a test key
    const isTestKey = value.includes('test') || value.includes('sandbox');

    return {
      isValid: true,
      isTestKey,
    };
  }

  /**
   * Create a GitHub repository secret
   *
   * Uses the GitHub Secrets API with libsodium encryption
   */
  async createGitHubSecret(request: GitHubSecretRequest): Promise<GitHubSecretResult> {
    this.logger.log(`Creating GitHub secret ${request.secretName} in ${request.owner}/${request.repo}`);

    try {
      // Get the repository public key for encryption
      const { data: publicKey } = await this.octokit.actions.getRepoPublicKey({
        owner: request.owner,
        repo: request.repo,
      });

      // Initialize libsodium
      await sodium.ready;

      // Encrypt the secret
      const binKey = sodium.from_base64(publicKey.key, sodium.base64_variants.ORIGINAL);
      const binSec = sodium.from_string(request.secretValue);
      const encBytes = sodium.crypto_box_seal(binSec, binKey);
      const encryptedValue = sodium.to_base64(encBytes, sodium.base64_variants.ORIGINAL);

      // Create or update the secret
      await this.octokit.actions.createOrUpdateRepoSecret({
        owner: request.owner,
        repo: request.repo,
        secret_name: request.secretName,
        encrypted_value: encryptedValue,
        key_id: publicKey.key_id,
      });

      this.logger.log(`Successfully created secret ${request.secretName}`);

      return {
        success: true,
        secretName: request.secretName,
      };
    } catch (error) {
      this.logger.error(`Failed to create GitHub secret: ${error.message}`);

      return {
        success: false,
        secretName: request.secretName,
        error: error.message,
      };
    }
  }

  /**
   * Generate .env.example file content
   */
  generateEnvExample(envVars: RequiredEnvVar[]): string {
    const lines: string[] = [
      '# Environment Variables',
      '# Copy this file to .env and fill in your values',
      '# NEVER commit your .env file to version control!',
      '',
    ];

    // Group by category
    const grouped = this.groupByCategory(envVars);

    for (const [category, vars] of Object.entries(grouped)) {
      lines.push(`# ${this.getCategoryLabel(category as EnvVarCategory)}`);

      for (const envVar of vars) {
        // Add description comment
        lines.push(`# ${envVar.description}`);

        if (envVar.documentationUrl) {
          lines.push(`# Get your key: ${envVar.documentationUrl}`);
        }

        // Add the variable with placeholder
        const placeholder = this.getPlaceholder(envVar);
        const prefix = envVar.required ? '' : '# ';
        lines.push(`${prefix}${envVar.name}=${placeholder}`);
        lines.push('');
      }
    }

    return lines.join('\n');
  }

  /**
   * Generate README section for environment variables
   */
  generateReadmeSection(envVars: RequiredEnvVar[]): string {
    if (envVars.length === 0) {
      return `## Environment Variables

This server does not require any environment variables by default.`;
    }

    const sections: string[] = [];
    sections.push('## Environment Variables');
    sections.push('');
    sections.push('This server requires the following environment variables:');
    sections.push('');

    // Table header
    sections.push('| Variable | Required | Description | Documentation |');
    sections.push('|----------|----------|-------------|---------------|');

    for (const envVar of envVars) {
      const required = envVar.required ? 'Yes' : 'No';
      const docs = envVar.documentationUrl
        ? `[Get key](${envVar.documentationUrl})`
        : '-';
      sections.push(`| \`${envVar.name}\` | ${required} | ${envVar.description} | ${docs} |`);
    }

    sections.push('');
    sections.push('### Setup Instructions');
    sections.push('');
    sections.push('1. Copy `.env.example` to `.env`:');
    sections.push('   ```bash');
    sections.push('   cp .env.example .env');
    sections.push('   ```');
    sections.push('');
    sections.push('2. Fill in your API keys and credentials');
    sections.push('');
    sections.push('3. **IMPORTANT**: Never commit your `.env` file to version control');
    sections.push('');

    // Add category-specific instructions
    const hasPayment = envVars.some(v => v.category === 'payment');
    if (hasPayment) {
      sections.push('### Payment Integration');
      sections.push('');
      sections.push('For testing, use test/sandbox API keys. Production keys should only be used in secure environments.');
      sections.push('');
    }

    return sections.join('\n');
  }

  /**
   * Get clarification questions for missing environment variables
   */
  generateClarificationQuestions(envVars: RequiredEnvVar[]): Array<{
    question: string;
    context: string;
    options?: string[];
    envVarName: string;
  }> {
    return envVars.map(envVar => ({
      question: `Please provide your ${envVar.description}`,
      context: envVar.documentationUrl
        ? `You can obtain this from: ${envVar.documentationUrl}`
        : `This ${envVar.required ? 'required' : 'optional'} credential is needed for the server to function properly.`,
      options: envVar.required ? undefined : ['Skip this (optional)'],
      envVarName: envVar.name,
    }));
  }

  // Helper methods

  private getCategoryDescription(category: EnvVarCategory): string {
    const descriptions: Record<EnvVarCategory, string> = {
      authentication: 'authentication credential',
      database: 'database connection',
      storage: 'storage credential',
      messaging: 'messaging service key',
      payment: 'payment processing key',
      analytics: 'analytics tracking ID',
      ai: 'AI service key',
      cloud: 'cloud provider credential',
      general: 'configuration value',
    };
    return descriptions[category];
  }

  private getCategoryLabel(category: EnvVarCategory): string {
    const labels: Record<EnvVarCategory, string> = {
      authentication: 'Authentication',
      database: 'Database',
      storage: 'Storage',
      messaging: 'Messaging Services',
      payment: 'Payment Processing',
      analytics: 'Analytics',
      ai: 'AI Services',
      cloud: 'Cloud Services',
      general: 'General Configuration',
    };
    return labels[category];
  }

  private generateEnvVarName(keyword: string, category: EnvVarCategory): string {
    const base = keyword.toUpperCase().replace(/\s+/g, '_').replace(/[^A-Z_]/g, '');
    const suffix = category === 'authentication' ? '_API_KEY' : '_KEY';
    return base + suffix;
  }

  private capitalizeFirst(str: string): string {
    return str.charAt(0).toUpperCase() + str.slice(1);
  }

  private groupByCategory(envVars: RequiredEnvVar[]): Record<string, RequiredEnvVar[]> {
    return envVars.reduce((acc, envVar) => {
      if (!acc[envVar.category]) {
        acc[envVar.category] = [];
      }
      acc[envVar.category].push(envVar);
      return acc;
    }, {} as Record<string, RequiredEnvVar[]>);
  }

  private getPlaceholder(envVar: RequiredEnvVar): string {
    // Find known pattern for placeholder
    const pattern = this.knownPatterns.find(p => p.envVarName === envVar.name);
    if (pattern) {
      return pattern.examplePlaceholder;
    }

    // Generate generic placeholder
    return `your-${envVar.name.toLowerCase().replace(/_/g, '-')}-here`;
  }
}
