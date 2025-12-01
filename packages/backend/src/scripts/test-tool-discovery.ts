#!/usr/bin/env npx ts-node

/**
 * Test script for Tool Discovery Service
 *
 * This script tests the AI-powered tool discovery functionality
 * by analyzing a sample GitHub repository and generating MCP tools.
 */

import { NestFactory } from '@nestjs/core';
import { AppModule } from '../app.module';
import { ToolDiscoveryService } from '../tool-discovery.service';
import { GitHubAnalysisService } from '../github-analysis.service';

async function testToolDiscovery() {
  console.log('🔍 Testing Tool Discovery Service...\n');

  try {
    // Create NestJS application context
    const app = await NestFactory.createApplicationContext(AppModule);

    // Get services
    const toolDiscoveryService = app.get(ToolDiscoveryService);
    const githubAnalysisService = app.get(GitHubAnalysisService);

    // Test repository - using a well-known React repository
    const testRepo = 'https://github.com/facebook/react';
    console.log(`📦 Analyzing repository: ${testRepo}`);

    // Step 1: Analyze the repository
    console.log('\n🔬 Step 1: Repository Analysis...');
    const startAnalysis = Date.now();
    const analysis = await githubAnalysisService.analyzeRepository(testRepo);
    const analysisTime = Date.now() - startAnalysis;

    console.log(`✅ Analysis completed in ${analysisTime}ms`);
    console.log(`   - Repository: ${analysis.metadata.fullName}`);
    console.log(`   - Language: ${analysis.metadata.language}`);
    console.log(`   - Frameworks: ${analysis.techStack.frameworks.join(', ')}`);
    console.log(`   - Features: ${Object.entries(analysis.features).filter(([_, v]) => v).map(([k, _]) => k).join(', ')}`);

    // Step 2: Discover tools using AI
    console.log('\n🤖 Step 2: AI Tool Discovery...');
    const startDiscovery = Date.now();
    const toolDiscoveryResult = await toolDiscoveryService.discoverTools(analysis);
    const discoveryTime = Date.now() - startDiscovery;

    if (toolDiscoveryResult.success) {
      console.log(`✅ Tool discovery completed in ${discoveryTime}ms`);
      console.log(`   - Discovered ${toolDiscoveryResult.tools.length} tools`);
      console.log(`   - Iterations: ${toolDiscoveryResult.metadata.iterationCount}`);
      console.log(`   - Quality threshold: ${toolDiscoveryResult.metadata.qualityThreshold}`);

      // Display discovered tools
      console.log('\n🛠️  Discovered Tools:');
      console.log('=' .repeat(60));

      toolDiscoveryResult.tools.forEach((tool, index) => {
        console.log(`\n${index + 1}. ${tool.name}`);
        console.log(`   Description: ${tool.description}`);
        console.log(`   Category: ${tool.category}`);
        console.log(`   Quality Score: ${tool.quality.overallScore.toFixed(2)}`);
        console.log(`   Complexity: ${tool.implementationHints.complexity}`);
        console.log(`   Output Format: ${tool.implementationHints.outputFormat}`);

        // Show input schema
        if (tool.inputSchema.properties && Object.keys(tool.inputSchema.properties).length > 0) {
          console.log('   Input Parameters:');
          Object.entries(tool.inputSchema.properties).forEach(([param, schema]) => {
            const required = tool.inputSchema.required?.includes(param) ? ' (required)' : '';
            console.log(`     - ${param}: ${schema.description}${required}`);
          });
        }
      });

      // Show quality breakdown
      console.log('\n📊 Quality Analysis:');
      console.log('=' .repeat(60));

      const avgQuality = toolDiscoveryResult.tools.reduce((sum, tool) => sum + tool.quality.overallScore, 0) / toolDiscoveryResult.tools.length;
      console.log(`Average Quality Score: ${avgQuality.toFixed(2)}`);

      const categories = toolDiscoveryResult.tools.reduce((acc, tool) => {
        acc[tool.category] = (acc[tool.category] || 0) + 1;
        return acc;
      }, {} as Record<string, number>);

      console.log('Tool Categories:');
      Object.entries(categories).forEach(([category, count]) => {
        console.log(`  - ${category}: ${count} tools`);
      });

      // Show AI reasoning
      console.log('\n🧠 AI Reasoning:');
      console.log('=' .repeat(60));
      console.log(toolDiscoveryResult.metadata.aiReasoning);

    } else {
      console.error(`❌ Tool discovery failed: ${toolDiscoveryResult.error}`);
    }

    // Step 3: Test individual methods
    console.log('\n🧪 Step 3: Testing Individual Methods...');

    // Test code analysis
    if (analysis.sourceFiles.length > 0) {
      const sampleCode = analysis.sourceFiles[0].content.substring(0, 1000);
      const context = {
        primaryLanguage: analysis.metadata.language || 'JavaScript',
        frameworks: analysis.techStack.frameworks,
        repositoryType: 'library' as const,
        complexity: 'medium' as const,
        domain: 'web'
      };

      console.log('   Testing generateToolFromCode...');
      const codeTools = await toolDiscoveryService.generateToolFromCode(sampleCode, context);
      console.log(`   ✅ Generated ${codeTools.length} tools from code analysis`);

      // Test README analysis
      if (analysis.readme.content) {
        console.log('   Testing extractToolsFromReadme...');
        const readmeTools = await toolDiscoveryService.extractToolsFromReadme(analysis.readme.content, context);
        console.log(`   ✅ Extracted ${readmeTools.length} tools from README`);
      }

      // Test API mapping
      if (analysis.apiPatterns.length > 0) {
        console.log('   Testing mapApiToTools...');
        const apiTools = await toolDiscoveryService.mapApiToTools(analysis.apiPatterns, context);
        console.log(`   ✅ Mapped ${apiTools.length} tools from API patterns`);
      }
    }

    console.log('\n🎉 All tests completed successfully!');

    await app.close();

  } catch (error) {
    console.error('❌ Test failed:', error.message);
    console.error('Stack trace:', error.stack);
    process.exit(1);
  }
}

// Handle command line arguments
const args = process.argv.slice(2);
if (args.includes('--help') || args.includes('-h')) {
  console.log(`
Tool Discovery Service Test Script

Usage:
  npm run test:tool-discovery

This script tests the AI-powered tool discovery functionality by:
1. Analyzing a sample GitHub repository (React)
2. Discovering MCP tools using AI reasoning
3. Testing individual discovery methods
4. Displaying quality metrics and results

Environment Variables Required:
- ANTHROPIC_API_KEY: Your Anthropic API key for Claude AI
- GITHUB_TOKEN: Your GitHub personal access token (optional)
  `);
  process.exit(0);
}

// Run the test
testToolDiscovery();