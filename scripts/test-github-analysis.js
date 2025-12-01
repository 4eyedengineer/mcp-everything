#!/usr/bin/env node

/**
 * Test script for GitHub Analysis Service
 * Tests the service with real GitHub repositories
 */

const { Octokit } = require('@octokit/rest');
require('dotenv').config();

const GITHUB_TOKEN = process.env.GITHUB_TOKEN;

if (!GITHUB_TOKEN) {
  console.error('❌ GITHUB_TOKEN not found in environment variables');
  console.log('Please add GITHUB_TOKEN to your .env file');
  process.exit(1);
}

const octokit = new Octokit({ auth: GITHUB_TOKEN });

// Test repositories
const TEST_REPOS = [
  'octocat/Hello-World',           // Simple repo
  'microsoft/vscode',              // Complex TypeScript repo
  'expressjs/express',             // JavaScript API framework
  'nestjs/nest',                   // TypeScript backend framework
];

async function testGitHubConnection() {
  try {
    console.log('🔍 Testing GitHub connection...');
    const { data: user } = await octokit.rest.users.getAuthenticated();
    console.log(`✅ Connected as: ${user.login}`);
    return true;
  } catch (error) {
    console.error('❌ GitHub connection failed:', error.message);
    return false;
  }
}

async function analyzeRepository(repoUrl) {
  console.log(`\n🔍 Analyzing: ${repoUrl}`);

  const [owner, repo] = repoUrl.split('/');

  try {
    // Get repository info
    const { data: repoInfo } = await octokit.rest.repos.get({ owner, repo });
    console.log(`  📝 Description: ${repoInfo.description || 'No description'}`);
    console.log(`  🌟 Stars: ${repoInfo.stargazers_count}`);
    console.log(`  📚 Language: ${repoInfo.language || 'Unknown'}`);

    // Get repository contents
    const { data: contents } = await octokit.rest.repos.getContent({
      owner,
      repo,
      path: '',
    });

    console.log(`  📁 Files/Directories: ${contents.length}`);

    // Count file types
    const fileTypes = {};
    const files = contents.filter(item => item.type === 'file');

    files.forEach(file => {
      const ext = file.name.split('.').pop() || 'no-extension';
      fileTypes[ext] = (fileTypes[ext] || 0) + 1;
    });

    console.log(`  🔍 File extensions:`, Object.entries(fileTypes)
      .sort(([,a], [,b]) => b - a)
      .slice(0, 5)
      .map(([ext, count]) => `${ext}(${count})`)
      .join(', '));

    // Look for API-related files
    const apiFiles = files.filter(file =>
      file.name.includes('api') ||
      file.name.includes('route') ||
      file.name.includes('controller') ||
      file.name.includes('endpoint')
    );

    if (apiFiles.length > 0) {
      console.log(`  🔌 API-related files: ${apiFiles.map(f => f.name).join(', ')}`);
    }

    // Check for package.json
    const packageFile = files.find(f => f.name === 'package.json');
    if (packageFile) {
      try {
        const { data: packageContent } = await octokit.rest.repos.getContent({
          owner,
          repo,
          path: 'package.json',
        });

        const packageJson = JSON.parse(Buffer.from(packageContent.content, 'base64').toString());
        const depCount = Object.keys(packageJson.dependencies || {}).length;
        const devDepCount = Object.keys(packageJson.devDependencies || {}).length;

        console.log(`  📦 Dependencies: ${depCount} runtime, ${devDepCount} dev`);

        // Look for common web frameworks
        const webFrameworks = ['express', 'fastify', 'koa', '@nestjs/core', 'next', 'nuxt'];
        const foundFrameworks = webFrameworks.filter(fw =>
          packageJson.dependencies?.[fw] || packageJson.devDependencies?.[fw]
        );

        if (foundFrameworks.length > 0) {
          console.log(`  🚀 Web frameworks: ${foundFrameworks.join(', ')}`);
        }
      } catch (error) {
        console.log(`  ⚠️  Could not parse package.json`);
      }
    }

    // Calculate complexity score (simple heuristic)
    const complexity = Math.min(10, Math.ceil(
      (files.length * 0.1) +
      (Object.keys(fileTypes).length * 0.5) +
      (repoInfo.stargazers_count > 1000 ? 2 : 0)
    ));

    console.log(`  📊 Complexity Score: ${complexity}/10`);

    return {
      success: true,
      repository: {
        owner,
        name: repo,
        url: `https://github.com/${owner}/${repo}`,
        description: repoInfo.description,
        stars: repoInfo.stargazers_count,
        language: repoInfo.language,
      },
      fileCount: files.length,
      fileTypes,
      complexity,
      hasPackageJson: !!packageFile,
      apiFiles: apiFiles.length,
    };

  } catch (error) {
    console.error(`  ❌ Error: ${error.message}`);
    return { success: false, error: error.message };
  }
}

async function testRateLimits() {
  try {
    const { data: rateLimit } = await octokit.rest.rateLimit.get();
    console.log(`\n📊 Rate Limit Status:`);
    console.log(`  Core: ${rateLimit.resources.core.remaining}/${rateLimit.resources.core.limit}`);
    console.log(`  Search: ${rateLimit.resources.search.remaining}/${rateLimit.resources.search.limit}`);

    if (rateLimit.resources.core.remaining < 100) {
      console.warn('⚠️  Low rate limit remaining');
      return false;
    }
    return true;
  } catch (error) {
    console.error('❌ Could not check rate limits');
    return false;
  }
}

async function main() {
  console.log('🚀 GitHub Analysis Service Test\n');

  // Test connection
  if (!(await testGitHubConnection())) {
    process.exit(1);
  }

  // Check rate limits
  if (!(await testRateLimits())) {
    process.exit(1);
  }

  // Test repositories
  const results = [];

  for (const repo of TEST_REPOS) {
    const result = await analyzeRepository(repo);
    results.push({ repo, ...result });

    // Small delay to be nice to GitHub API
    await new Promise(resolve => setTimeout(resolve, 1000));
  }

  // Summary
  console.log('\n📋 Test Summary:');
  const successful = results.filter(r => r.success);
  const failed = results.filter(r => !r.success);

  console.log(`✅ Successful: ${successful.length}/${results.length}`);
  if (failed.length > 0) {
    console.log(`❌ Failed: ${failed.length}/${results.length}`);
    failed.forEach(r => console.log(`  - ${r.repo}: ${r.error}`));
  }

  if (successful.length > 0) {
    console.log('\n🎯 Analysis Results:');
    successful.forEach(r => {
      console.log(`  ${r.repo}: ${r.fileCount} files, complexity ${r.complexity}/10`);
    });
  }

  console.log('\n✅ GitHub Analysis Service test complete!');

  if (successful.length === TEST_REPOS.length) {
    console.log('🎉 All tests passed! Service is working correctly.');
    process.exit(0);
  } else {
    console.log('⚠️  Some tests failed. Check configuration and network connectivity.');
    process.exit(1);
  }
}

// Handle errors
process.on('unhandledRejection', (error) => {
  console.error('❌ Unhandled error:', error);
  process.exit(1);
});

main();