import { Injectable } from '@nestjs/common';
import { DeploymentFile } from '../types/deployment.types';

@Injectable()
export class GitignoreProvider {
  /**
   * Generate a .gitignore file for Node.js/TypeScript MCP servers
   */
  generateGitignoreFile(): DeploymentFile {
    const content = `# Dependencies
node_modules/

# Build output
dist/
build/

# Environment files
.env
.env.local
.env.*.local

# IDE
.idea/
.vscode/
*.swp
*.swo

# OS files
.DS_Store
Thumbs.db

# Logs
*.log
npm-debug.log*
yarn-debug.log*
yarn-error.log*

# Test coverage
coverage/

# TypeScript cache
*.tsbuildinfo
`;

    return {
      path: '.gitignore',
      content,
    };
  }

  /**
   * Generate .gitignore files as an array for easy spreading into deployment files
   */
  generateGitignoreFiles(): DeploymentFile[] {
    return [this.generateGitignoreFile()];
  }
}
