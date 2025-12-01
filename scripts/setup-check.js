#!/usr/bin/env node

/**
 * Setup Check Script
 * Validates that the development environment is properly configured
 */

require('dotenv').config();

const REQUIRED_ENV_VARS = [
  'ANTHROPIC_API_KEY',
  'GITHUB_TOKEN',
  'JWT_SECRET',
];

const OPTIONAL_ENV_VARS = [
  'DATABASE_URL',
  'DOCKER_HOST',
  'PORT',
];

function checkEnvironmentVariables() {
  console.log('🔍 Checking environment variables...\n');

  let allRequired = true;
  const missing = [];
  const configured = [];

  // Check required variables
  REQUIRED_ENV_VARS.forEach(varName => {
    const value = process.env[varName];
    if (!value || value === '') {
      console.log(`❌ ${varName}: Missing or empty`);
      missing.push(varName);
      allRequired = false;
    } else {
      console.log(`✅ ${varName}: Configured`);
      configured.push(varName);

      // Additional validation for specific variables
      if (varName === 'ANTHROPIC_API_KEY' && !value.startsWith('sk-ant-')) {
        console.log(`⚠️  ${varName}: Value doesn't look like a valid Anthropic key`);
      }
      if (varName === 'GITHUB_TOKEN' && !value.startsWith('ghp_') && !value.startsWith('github_pat_')) {
        console.log(`⚠️  ${varName}: Value doesn't look like a valid GitHub token`);
      }
      if (varName === 'JWT_SECRET' && value.length < 32) {
        console.log(`⚠️  ${varName}: Should be at least 32 characters long`);
      }
    }
  });

  // Check optional variables
  console.log('\n📋 Optional configuration:');
  OPTIONAL_ENV_VARS.forEach(varName => {
    const value = process.env[varName];
    if (value && value !== '') {
      console.log(`✅ ${varName}: ${value}`);
    } else {
      console.log(`⚪ ${varName}: Using default`);
    }
  });

  return { allRequired, missing, configured };
}

function checkNodeVersion() {
  console.log('\n🔍 Checking Node.js version...');

  const nodeVersion = process.version;
  const majorVersion = parseInt(nodeVersion.slice(1).split('.')[0]);

  if (majorVersion >= 18) {
    console.log(`✅ Node.js ${nodeVersion} (compatible)`);
    return true;
  } else {
    console.log(`❌ Node.js ${nodeVersion} (requires 18+)`);
    return false;
  }
}

function checkPackageManager() {
  console.log('\n🔍 Checking package manager...');

  const { execSync } = require('child_process');

  try {
    const npmVersion = execSync('npm --version', { encoding: 'utf8' }).trim();
    console.log(`✅ npm ${npmVersion}`);
    return true;
  } catch (error) {
    console.log('❌ npm not found');
    return false;
  }
}

function checkDependencies() {
  console.log('\n🔍 Checking dependencies...');

  const fs = require('fs');
  const path = require('path');

  // Check if node_modules exists
  if (fs.existsSync(path.join(process.cwd(), 'node_modules'))) {
    console.log('✅ Dependencies installed');
    return true;
  } else {
    console.log('❌ Dependencies not installed (run: npm install)');
    return false;
  }
}

function checkDocker() {
  console.log('\n🔍 Checking Docker...');

  const { execSync } = require('child_process');

  try {
    const dockerVersion = execSync('docker --version', { encoding: 'utf8' }).trim();
    console.log(`✅ ${dockerVersion}`);

    // Check if Docker daemon is running
    try {
      execSync('docker info', { stdio: 'ignore' });
      console.log('✅ Docker daemon is running');
      return true;
    } catch {
      console.log('⚠️  Docker installed but daemon not running');
      return false;
    }
  } catch (error) {
    console.log('❌ Docker not found or not installed');
    return false;
  }
}

function printSetupInstructions(missing) {
  if (missing.length === 0) return;

  console.log('\n🔧 Setup Instructions:\n');

  if (missing.includes('ANTHROPIC_API_KEY')) {
    console.log('1. Get Anthropic API Key:');
    console.log('   → Visit: https://console.anthropic.com');
    console.log('   → Create account and get API key');
    console.log('   → Add to .env: ANTHROPIC_API_KEY=sk-ant-your-key-here\n');
  }

  if (missing.includes('GITHUB_TOKEN')) {
    console.log('2. Get GitHub Token:');
    console.log('   → Visit: https://github.com/settings/tokens');
    console.log('   → Generate new token with "gist" permission');
    console.log('   → Add to .env: GITHUB_TOKEN=ghp_your-token-here\n');
  }

  if (missing.includes('JWT_SECRET')) {
    console.log('3. Set JWT Secret:');
    console.log('   → Generate secure random string (32+ chars)');
    console.log('   → Add to .env: JWT_SECRET=your-secure-secret-here\n');
  }

  console.log('4. Copy .env.example to .env if you haven\'t already:');
  console.log('   → cp .env.example .env\n');
}

function printNextSteps() {
  console.log('\n🚀 Next Steps:\n');
  console.log('1. Start the development environment:');
  console.log('   → npm run docker:up\n');
  console.log('2. Or start services individually:');
  console.log('   → npm run dev:backend');
  console.log('   → npm run dev:frontend (in another terminal)\n');
  console.log('3. Test GitHub integration:');
  console.log('   → npm run test:github\n');
  console.log('4. Generate your first MCP server:');
  console.log('   → npm run generate-mcp -- --source github --url https://github.com/octocat/Hello-World\n');
}

function main() {
  console.log('🚀 MCP Everything - Setup Check\n');

  let allGood = true;

  // Check Node.js
  if (!checkNodeVersion()) {
    allGood = false;
  }

  // Check package manager
  if (!checkPackageManager()) {
    allGood = false;
  }

  // Check dependencies
  if (!checkDependencies()) {
    allGood = false;
  }

  // Check Docker
  if (!checkDocker()) {
    console.log('⚠️  Docker issues detected - containerized features may not work');
  }

  // Check environment variables
  const { allRequired, missing } = checkEnvironmentVariables();
  if (!allRequired) {
    allGood = false;
    printSetupInstructions(missing);
  }

  // Summary
  console.log('\n📊 Setup Summary:');
  if (allGood) {
    console.log('✅ All checks passed! You\'re ready to develop.');
    printNextSteps();
    process.exit(0);
  } else {
    console.log('❌ Some issues found. Please fix them before continuing.');
    console.log('\nFor detailed setup instructions, see: README.md');
    process.exit(1);
  }
}

main();