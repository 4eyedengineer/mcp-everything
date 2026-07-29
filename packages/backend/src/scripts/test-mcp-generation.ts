#!/usr/bin/env ts-node

import { NestFactory } from '@nestjs/core';
import { AppModule } from '../app.module';
import { McpGenerationService } from '../mcp-generation.service';

async function testMcpGeneration() {
  console.log('🚀 Testing MCP Generation Service');
  console.log('=====================================');

  try {
    // Create NestJS application context
    const app = await NestFactory.createApplicationContext(AppModule);
    const mcpGenerationService = app.get(McpGenerationService);

    // Test with a simple GitHub repository
    const testUrl = 'https://github.com/microsoft/TypeScript';

    console.log(`📦 Generating MCP server for: ${testUrl}`);
    console.log('⏳ This may take a few minutes...\n');

    const startTime = Date.now();

    // Generate MCP server
    const result = await mcpGenerationService.generateMCPServer(testUrl);

    const duration = Date.now() - startTime;

    console.log('✅ MCP Server Generation Completed!');
    console.log(`⏱️  Duration: ${duration}ms`);
    console.log(`📁 Server Name: ${result.serverName}`);
    console.log(`🆔 Conversation ID: ${result.conversationId}`);
    console.log(`📝 Description: ${result.metadata.description}`);
    console.log(`🛠️  Tools Generated: ${result.metadata.tools.length}`);
    console.log(`📄 Files Generated: ${result.files.length}`);
    console.log('');

    // Show tools
    console.log('🔧 Generated Tools:');
    result.metadata.tools.forEach((tool, index) => {
      console.log(`  ${index + 1}. ${tool.name}: ${tool.description}`);
    });
    console.log('');

    // Show files
    console.log('📂 Generated Files:');
    result.files.forEach((file, index) => {
      console.log(`  ${index + 1}. ${file.path} (${file.content.length} bytes)`);
    });
    console.log('');

    // Show quality validation
    console.log('✅ Quality Validation:');
    console.log(`  Passed: ${result.metadata.quality.passed}`);
    console.log(`  Compiles: ${result.metadata.quality.compiles}`);
    console.log(`  MCP Compliant: ${result.metadata.quality.mcpCompliant}`);
    console.log(`  Tools Implemented: ${result.metadata.quality.toolsImplemented}`);
    console.log(`  Regeneration Count: ${result.metadata.quality.regenerationCount}`);

    if (result.metadata.quality.errors.length > 0) {
      console.log('❌ Errors:');
      result.metadata.quality.errors.forEach((error) => {
        console.log(`  - ${error}`);
      });
    }

    if (result.metadata.quality.warnings.length > 0) {
      console.log('⚠️  Warnings:');
      result.metadata.quality.warnings.forEach((warning) => {
        console.log(`  - ${warning}`);
      });
    }

    console.log('\n🎉 Test completed successfully!');

    await app.close();
  } catch (error) {
    console.error('❌ Test failed:', error.message);
    console.error('Stack trace:', error.stack);
    process.exit(1);
  }
}

// Handle graceful shutdown
process.on('SIGINT', () => {
  console.log('\n⚠️ Received SIGINT, shutting down gracefully...');
  process.exit(0);
});

process.on('SIGTERM', () => {
  console.log('\n⚠️ Received SIGTERM, shutting down gracefully...');
  process.exit(0);
});

// Run the test
testMcpGeneration().catch((error) => {
  console.error('💥 Unhandled error:', error);
  process.exit(1);
});
