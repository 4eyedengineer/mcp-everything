import { Injectable, Logger } from '@nestjs/common';
import { DevContainerConfig, DeploymentFile } from '../types/deployment.types';

@Injectable()
export class DevContainerProvider {
  private readonly logger = new Logger(DevContainerProvider.name);

  /**
   * Generate a devcontainer.json configuration for an MCP server
   */
  generateDevContainer(
    serverName: string,
    language: 'typescript' | 'javascript' | 'python' = 'typescript',
  ): DevContainerConfig {
    const baseConfig: DevContainerConfig = {
      name: `${serverName} MCP Server`,
      image: this.getBaseImage(language),
      features: this.getFeatures(language),
      customizations: {
        vscode: {
          extensions: this.getExtensions(language),
          settings: this.getSettings(language),
        },
      },
      postCreateCommand: this.getPostCreateCommand(language),
      remoteUser: 'vscode',
    };

    return baseConfig;
  }

  /**
   * Generate devcontainer files for a deployment
   */
  generateDevContainerFiles(
    serverName: string,
    language: 'typescript' | 'javascript' | 'python' = 'typescript',
  ): DeploymentFile[] {
    const config = this.generateDevContainer(serverName, language);

    return [
      {
        path: '.devcontainer/devcontainer.json',
        content: JSON.stringify(config, null, 2),
      },
    ];
  }

  private getBaseImage(language: string): string {
    switch (language) {
      case 'typescript':
      case 'javascript':
        return 'mcr.microsoft.com/devcontainers/typescript-node:1-20';
      case 'python':
        return 'mcr.microsoft.com/devcontainers/python:1-3.11';
      default:
        return 'mcr.microsoft.com/devcontainers/base:ubuntu';
    }
  }

  private getFeatures(language: string): Record<string, unknown> {
    const features: Record<string, unknown> = {
      'ghcr.io/devcontainers/features/git:1': {},
    };

    switch (language) {
      case 'typescript':
      case 'javascript':
        features['ghcr.io/devcontainers/features/node:1'] = {
          version: '20',
        };
        break;
      case 'python':
        features['ghcr.io/devcontainers/features/python:1'] = {
          version: '3.11',
        };
        break;
    }

    return features;
  }

  private getExtensions(language: string): string[] {
    const baseExtensions = [
      'streetsidesoftware.code-spell-checker',
      'EditorConfig.EditorConfig',
      'ms-azuretools.vscode-docker',
    ];

    switch (language) {
      case 'typescript':
        return [
          ...baseExtensions,
          'ms-vscode.vscode-typescript-next',
          'esbenp.prettier-vscode',
          'dbaeumer.vscode-eslint',
        ];
      case 'javascript':
        return [
          ...baseExtensions,
          'esbenp.prettier-vscode',
          'dbaeumer.vscode-eslint',
        ];
      case 'python':
        return [
          ...baseExtensions,
          'ms-python.python',
          'ms-python.vscode-pylance',
          'ms-python.black-formatter',
        ];
      default:
        return baseExtensions;
    }
  }

  private getSettings(language: string): Record<string, unknown> {
    const baseSettings = {
      'editor.formatOnSave': true,
      'editor.tabSize': 2,
    };

    switch (language) {
      case 'typescript':
      case 'javascript':
        return {
          ...baseSettings,
          'editor.defaultFormatter': 'esbenp.prettier-vscode',
          'typescript.preferences.importModuleSpecifier': 'relative',
        };
      case 'python':
        return {
          ...baseSettings,
          'editor.defaultFormatter': 'ms-python.black-formatter',
          'python.analysis.typeCheckingMode': 'basic',
        };
      default:
        return baseSettings;
    }
  }

  private getPostCreateCommand(language: string): string {
    switch (language) {
      case 'typescript':
      case 'javascript':
        // Install, build, and run tests to validate the MCP server
        return 'npm install && npm run build && npm test --if-present';
      case 'python':
        // Install dependencies and run tests if pytest is available
        return 'pip install -e . && pip install -r requirements-dev.txt 2>/dev/null || true && python -m pytest 2>/dev/null || true';
      default:
        return 'echo "Setup complete"';
    }
  }
}
