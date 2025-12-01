#!/usr/bin/env node

/**
 * MCP Generation CLI Script
 *
 * Quick command-line tool to generate MCP servers locally
 * Usage: npm run generate-mcp -- --source github --url https://github.com/user/repo
 */

const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const args = process.argv.slice(2);
const options = {};

// Parse command line arguments
for (let i = 0; i < args.length; i += 2) {
  const key = args[i].replace('--', '');
  const value = args[i + 1];
  options[key] = value;
}

function displayHelp() {
  console.log(`
MCP Everything - Local Generation Script

Usage:
  npm run generate-mcp -- --source <type> --url <input>

Options:
  --source    Source type: 'github', 'api', or 'description'
  --url       Input URL (for github/api) or description text
  --name      Optional name for the generated server
  --output    Output directory (default: ./generated-servers)

Examples:
  npm run generate-mcp -- --source github --url https://github.com/octocat/Hello-World
  npm run generate-mcp -- --source api --url https://api.example.com/openapi.json
  npm run generate-mcp -- --source description --url "A weather API MCP server"

Environment:
  Make sure you have set up your .env file with ANTHROPIC_API_KEY and GITHUB_TOKEN
  `);
}

function validateOptions() {
  if (!options.source || !options.url) {
    console.error('❌ Missing required options: --source and --url are required');
    displayHelp();
    process.exit(1);
  }

  if (!['github', 'api', 'description'].includes(options.source)) {
    console.error('❌ Invalid source type. Must be: github, api, or description');
    process.exit(1);
  }

  // Check if backend is running
  try {
    execSync('curl -f http://localhost:3000/api/v1/health', { stdio: 'ignore' });
  } catch (error) {
    console.error('❌ Backend server is not running. Please start it with: npm run dev:backend');
    process.exit(1);
  }
}

function generateMcpServer() {
  console.log('🚀 Starting MCP server generation...');
  console.log(`📝 Source: ${options.source}`);
  console.log(`🔗 Input: ${options.url}`);

  const payload = {
    sourceType: options.source,
    sourceUrl: options.url,
    serverName: options.name || `mcp-server-${Date.now()}`,
    options: {
      includeTests: true,
      includeDocumentation: true,
      generateDocker: true
    }
  };

  try {
    const response = execSync(`curl -X POST http://localhost:3000/api/v1/generation/pipeline \\
      -H "Content-Type: application/json" \\
      -d '${JSON.stringify(payload)}'`, {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'inherit']
    });

    const result = JSON.parse(response);

    if (result.success) {
      console.log('✅ MCP server generated successfully!');
      console.log(`📁 Output directory: ${result.outputPath}`);
      console.log(`🐳 Docker image: ${result.dockerImage}`);
      console.log(`📚 Documentation: ${result.outputPath}/README.md`);

      // List generated files
      const outputDir = result.outputPath;
      if (fs.existsSync(outputDir)) {
        console.log('\\n📋 Generated files:');
        const files = fs.readdirSync(outputDir);
        files.forEach(file => {
          console.log(`   • ${file}`);
        });
      }
    } else {
      console.error('❌ Generation failed:', result.error);
      process.exit(1);
    }
  } catch (error) {
    console.error('❌ Error calling generation API:', error.message);
    process.exit(1);
  }
}

// Main execution
if (args.includes('--help') || args.includes('-h')) {
  displayHelp();
  process.exit(0);
}

validateOptions();
generateMcpServer();