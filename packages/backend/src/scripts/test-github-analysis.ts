#!/usr/bin/env ts-node

/**
 * Test script for GitHubAnalysisService
 *
 * Usage: ts-node src/scripts/test-github-analysis.ts
 *
 * This script demonstrates the comprehensive GitHub repository analysis capabilities
 * and can be used to test the service with real repositories.
 */

import { ConfigService } from '@nestjs/config';
import { GitHubAnalysisService } from '../github-analysis.service';
import { RepositoryAnalysis } from '../types/github-analysis.types';

// Simple config mock for testing
class MockConfigService extends ConfigService {
  get(key: string): any {
    if (key === 'GITHUB_TOKEN') {
      return process.env.GITHUB_TOKEN || undefined;
    }
    return undefined;
  }
}

async function testGitHubAnalysis() {
  console.log('🔍 Testing GitHub Analysis Service\n');

  const configService = new MockConfigService();
  const analysisService = new GitHubAnalysisService(configService);

  // Test repositories - you can modify these
  const testRepos = [
    'https://github.com/microsoft/vscode',
    'https://github.com/nestjs/nest',
    'https://github.com/facebook/react',
    'https://github.com/4eyedengineer/mcp-everything' // Our own repo
  ];

  for (const repoUrl of testRepos) {
    try {
      console.log(`\n📊 Analyzing: ${repoUrl}`);
      console.log('─'.repeat(60));

      const startTime = Date.now();
      const analysis: RepositoryAnalysis = await analysisService.analyzeRepository(repoUrl);
      const duration = Date.now() - startTime;

      // Display analysis results
      console.log(`✅ Analysis completed in ${duration}ms\n`);

      console.log('📋 Repository Metadata:');
      console.log(`  Name: ${analysis.metadata.name}`);
      console.log(`  Description: ${analysis.metadata.description || 'No description'}`);
      console.log(`  Primary Language: ${analysis.metadata.language || 'Unknown'}`);
      console.log(`  Stars: ${analysis.metadata.stargazersCount}`);
      console.log(`  Forks: ${analysis.metadata.forksCount}`);
      console.log(`  Topics: ${analysis.metadata.topics.join(', ') || 'None'}`);

      console.log('\n🔧 Technology Stack:');
      console.log(`  Languages: ${analysis.techStack.languages.join(', ')}`);
      console.log(`  Frameworks: ${analysis.techStack.frameworks.join(', ')}`);
      console.log(`  Build Systems: ${analysis.techStack.buildSystems.join(', ')}`);
      console.log(`  Package Managers: ${analysis.techStack.packageManagers.join(', ')}`);
      console.log(`  Confidence: ${Math.round(analysis.techStack.confidence * 100)}%`);

      console.log('\n🌐 API Patterns:');
      if (analysis.apiPatterns.length > 0) {
        analysis.apiPatterns.forEach(pattern => {
          console.log(`  ${pattern.type}: ${pattern.endpoints.length} endpoints`);
          console.log(`    Methods: ${pattern.methods.join(', ')}`);
          console.log(`    Confidence: ${Math.round(pattern.confidence * 100)}%`);
        });
      } else {
        console.log('  No API patterns detected');
      }

      console.log('\n🚀 Features:');
      console.log(`  ${analysis.features.features.join(', ')}`);

      console.log('\n📁 File Structure:');
      console.log(`  Total files analyzed: ${analysis.fileTree.length}`);
      console.log(`  Main source files: ${analysis.sourceFiles.length}`);

      console.log('\n📖 Documentation:');
      console.log(`  README found: ${analysis.quality.hasReadme ? 'Yes' : 'No'}`);
      console.log(`  Features extracted: ${analysis.readme.extractedFeatures.length}`);

      console.log('\n⭐ Quality Score:');
      console.log(`  Overall score: ${analysis.quality.score}/10`);
      console.log(`  Has tests: ${analysis.quality.hasTests ? 'Yes' : 'No'}`);
      console.log(`  Has license: ${analysis.quality.hasLicense ? 'Yes' : 'No'}`);
      console.log(`  Has CI/CD: ${analysis.features.hasCi ? 'Yes' : 'No'}`);

      console.log('\n📄 Key Source Files:');
      analysis.sourceFiles.slice(0, 5).forEach(file => {
        console.log(`  ${file.path} (${file.type}, ${file.size} bytes)`);
      });

      console.log('\n' + '═'.repeat(60));

    } catch (error) {
      console.error(`❌ Failed to analyze ${repoUrl}:`);
      console.error(`   Error: ${error.message}\n`);
    }

    // Add a small delay to respect rate limits
    await new Promise(resolve => setTimeout(resolve, 1000));
  }

  console.log('\n🎉 GitHub Analysis testing completed!');
  console.log('\n💡 Tips:');
  console.log('  - Set GITHUB_TOKEN environment variable for higher rate limits');
  console.log('  - The service caches results to improve performance');
  console.log('  - Analysis results can be used for AI-powered MCP server generation');
}

async function testSingleRepository() {
  const repoUrl = process.argv[2];
  if (!repoUrl) {
    console.log('Usage: ts-node test-github-analysis.ts <github-url>');
    console.log('Example: ts-node test-github-analysis.ts https://github.com/microsoft/vscode');
    return;
  }

  console.log(`🔍 Analyzing single repository: ${repoUrl}\n`);

  const configService = new MockConfigService();
  const analysisService = new GitHubAnalysisService(configService);

  try {
    const analysis = await analysisService.analyzeRepository(repoUrl);
    console.log(JSON.stringify(analysis, null, 2));
  } catch (error) {
    console.error('❌ Analysis failed:', error.message);
  }
}

// Run the appropriate test based on arguments
if (require.main === module) {
  if (process.argv.length > 2) {
    testSingleRepository().catch(console.error);
  } else {
    testGitHubAnalysis().catch(console.error);
  }
}

export { testGitHubAnalysis, testSingleRepository };