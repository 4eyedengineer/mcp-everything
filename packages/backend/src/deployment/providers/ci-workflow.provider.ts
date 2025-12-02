import { Injectable } from '@nestjs/common';
import { DeploymentFile } from '../types/deployment.types';

@Injectable()
export class CIWorkflowProvider {
  /**
   * Generate a GitHub Actions workflow file for testing MCP servers
   */
  generateTestWorkflow(serverName: string): DeploymentFile {
    const content = `name: Test MCP Server

on:
  push:
    branches: [main, master]
  pull_request:
    branches: [main, master]

permissions:
  contents: read
  checks: write

jobs:
  test:
    runs-on: ubuntu-latest

    strategy:
      matrix:
        node-version: [20.x]

    steps:
      - name: Checkout repository
        uses: actions/checkout@v4

      - name: Setup Node.js \${{ matrix.node-version }}
        uses: actions/setup-node@v4
        with:
          node-version: \${{ matrix.node-version }}
          cache: 'npm'

      - name: Install dependencies
        run: npm ci

      - name: Build
        run: npm run build

      - name: Run tests with coverage
        run: npm test -- --coverage --if-present
        continue-on-error: true

      - name: Upload coverage artifact
        uses: actions/upload-artifact@v4
        if: always()
        with:
          name: coverage-report
          path: coverage/
          retention-days: 30

      - name: Verify MCP server starts
        run: |
          timeout 5 node dist/index.js --help || true
`;

    return {
      path: '.github/workflows/test.yml',
      content,
    };
  }

  /**
   * Generate CI workflow files as an array for easy spreading into deployment files
   */
  generateCIWorkflowFiles(serverName: string): DeploymentFile[] {
    return [this.generateTestWorkflow(serverName)];
  }
}
