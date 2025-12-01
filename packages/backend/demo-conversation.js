#!/usr/bin/env node

/**
 * Demo Script: AI-First Conversational Interface for MCP Everything
 *
 * This script demonstrates the natural language conversation capabilities
 * that transform user interaction from rigid API calls to intelligent dialogue.
 */

const readline = require('readline');
const fetch = require('node-fetch');

// Configuration
const API_BASE = process.env.API_URL || 'http://localhost:3000';
const DEMO_MODE = process.env.DEMO_MODE !== 'false'; // Set to false for live testing

// ANSI Colors for better terminal output
const colors = {
  user: '\x1b[36m',      // Cyan
  assistant: '\x1b[32m', // Green
  system: '\x1b[33m',    // Yellow
  error: '\x1b[31m',     // Red
  reset: '\x1b[0m',      // Reset
  bold: '\x1b[1m',       // Bold
  dim: '\x1b[2m'         // Dim
};

class ConversationDemo {
  constructor() {
    this.conversationId = null;
    this.rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout
    });
  }

  /**
   * Display welcome message and demo information
   */
  showWelcome() {
    console.log(`${colors.bold}${colors.system}
╔══════════════════════════════════════════════════════════════════════════════╗
║                    MCP Everything - AI-First Conversation Demo               ║
║                                                                              ║
║  Transform from: {"githubUrl": "https://github.com/owner/repo"}             ║
║  Transform to:   "Generate an MCP server for the React repository"          ║
║                                                                              ║
║  🤖 Natural Language Understanding                                           ║
║  🔄 Multi-turn Conversations                                                 ║
║  🎯 Intent Detection & URL Resolution                                        ║
║  ⚡ Smart Repository Recognition                                              ║
╚══════════════════════════════════════════════════════════════════════════════╝
${colors.reset}`);

    if (DEMO_MODE) {
      console.log(`${colors.system}
🎭 DEMO MODE: Running with simulated responses
   Set DEMO_MODE=false to test against live API
${colors.reset}`);
    }

    console.log(`${colors.dim}
Try these examples:
• "Generate an MCP server for https://github.com/microsoft/vscode"
• "I want to create a server from the React repository"
• "Make an MCP server for Express.js"
• "Can you help me with github.com/openai/gpt-3"
• "What can you do?"
• "Help"

Type 'quit' or 'exit' to end the demo.
${colors.reset}\n`);
  }

  /**
   * Main conversation loop
   */
  async startConversation() {
    this.showWelcome();

    while (true) {
      const userInput = await this.getUserInput();

      if (userInput.toLowerCase() === 'quit' || userInput.toLowerCase() === 'exit') {
        console.log(`${colors.system}Thanks for trying the MCP Everything conversational interface!${colors.reset}`);
        break;
      }

      if (userInput.toLowerCase() === 'demo') {
        await this.runDemoScenarios();
        continue;
      }

      if (userInput.toLowerCase() === 'clear') {
        this.conversationId = null;
        console.log(`${colors.system}Conversation cleared. Starting fresh!${colors.reset}\n`);
        continue;
      }

      await this.processUserMessage(userInput);
    }

    this.rl.close();
  }

  /**
   * Get user input with a nice prompt
   */
  getUserInput() {
    return new Promise((resolve) => {
      this.rl.question(`${colors.user}You: ${colors.reset}`, (answer) => {
        resolve(answer.trim());
      });
    });
  }

  /**
   * Process user message through the conversational API
   */
  async processUserMessage(message) {
    try {
      console.log(`${colors.dim}🤖 Processing your message...${colors.reset}`);

      let response;
      if (DEMO_MODE) {
        response = await this.simulateApiResponse(message);
      } else {
        response = await this.callChatApi(message);
      }

      this.displayResponse(response);

      // Update conversation ID for multi-turn conversations
      if (response.conversationId) {
        this.conversationId = response.conversationId;
      }

    } catch (error) {
      console.log(`${colors.error}Error: ${error.message}${colors.reset}\n`);
    }
  }

  /**
   * Call the actual /chat API endpoint
   */
  async callChatApi(message) {
    const payload = {
      message: message,
      ...(this.conversationId && { conversationId: this.conversationId })
    };

    const response = await fetch(`${API_BASE}/chat`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload)
    });

    if (!response.ok) {
      throw new Error(`API Error: ${response.status} ${response.statusText}`);
    }

    return await response.json();
  }

  /**
   * Simulate API responses for demo purposes
   */
  async simulateApiResponse(message) {
    // Simulate processing delay
    await new Promise(resolve => setTimeout(resolve, 800));

    const lowerMessage = message.toLowerCase();

    // Help responses
    if (lowerMessage.includes('help') || lowerMessage.includes('what can you')) {
      return {
        success: true,
        conversationId: this.generateUUID(),
        intent: 'help',
        response: `I help you generate MCP (Model Context Protocol) servers from GitHub repositories!

You can ask me things like:
• "Generate an MCP server for https://github.com/microsoft/vscode"
• "Create a server from the React repository"
• "Make an MCP server for my auth library at github.com/user/repo"

Just tell me about the repository you'd like to turn into an MCP server!`,
        stage: 'completed'
      };
    }

    // Repository generation requests
    if (this.containsGenerationIntent(lowerMessage)) {
      const extractedRepo = this.extractRepositoryInfo(message);

      if (extractedRepo.success) {
        return {
          success: true,
          conversationId: this.conversationId || this.generateUUID(),
          intent: 'generate_mcp_server',
          extractedUrl: extractedRepo.url,
          response: `Perfect! I've identified the repository: ${extractedRepo.url}

I'm now generating an MCP server for ${extractedRepo.name}. The server will include:
🔧 Repository analysis and metadata extraction
🛠️ Custom tools based on the repository's functionality
📝 Complete TypeScript implementation with MCP SDK
🚀 Ready-to-run package with build configuration

${extractedRepo.description || 'This repository will be analyzed to create relevant MCP tools.'}`,
          server: {
            name: `${extractedRepo.name.toLowerCase()}-mcp-server`,
            description: `MCP Server generated from ${extractedRepo.name}`,
            tools: ['repository_info', 'code_analysis', 'file_operations']
          },
          followUp: "Would you like me to customize any specific tools or add additional functionality?",
          stage: 'completed'
        };
      } else {
        return {
          success: false,
          conversationId: this.conversationId || this.generateUUID(),
          intent: 'clarification_needed',
          response: "I'd love to generate an MCP server for you! Could you provide the GitHub URL or repository name? For example: 'github.com/owner/repo' or just 'react'",
          stage: 'clarification'
        };
      }
    }

    // Clarification responses for follow-up questions
    if (this.conversationId && this.containsRepositoryInfo(message)) {
      const extractedRepo = this.extractRepositoryInfo(message);
      if (extractedRepo.success) {
        return this.simulateApiResponse(`Generate an MCP server for ${extractedRepo.url}`);
      }
    }

    // Default response for unclear intent
    return {
      success: false,
      conversationId: this.conversationId || this.generateUUID(),
      intent: 'clarification_needed',
      response: "I specialize in generating MCP servers from GitHub repositories. Could you tell me about a repository you'd like to convert? You can provide a GitHub URL or just mention a popular repository name like 'React' or 'Express'.",
      stage: 'clarification'
    };
  }

  /**
   * Display the API response in a formatted way
   */
  displayResponse(response) {
    console.log(`${colors.assistant}Assistant: ${response.response}${colors.reset}`);

    if (response.extractedUrl) {
      console.log(`${colors.dim}🔗 Repository: ${response.extractedUrl}${colors.reset}`);
    }

    if (response.server) {
      console.log(`${colors.dim}📦 Server: ${response.server.name}${colors.reset}`);
      if (response.server.tools) {
        console.log(`${colors.dim}🛠️  Tools: ${response.server.tools.join(', ')}${colors.reset}`);
      }
    }

    if (response.followUp) {
      console.log(`${colors.dim}💡 ${response.followUp}${colors.reset}`);
    }

    if (response.intent) {
      console.log(`${colors.dim}🎯 Detected Intent: ${response.intent}${colors.reset}`);
    }

    console.log(`${colors.dim}📊 Stage: ${response.stage}${colors.reset}\n`);
  }

  /**
   * Run predefined demo scenarios
   */
  async runDemoScenarios() {
    console.log(`${colors.system}
🎭 Running Demo Scenarios:
${colors.reset}`);

    const scenarios = [
      {
        name: "Direct GitHub URL",
        input: "Generate an MCP server for https://github.com/microsoft/vscode"
      },
      {
        name: "Natural Language Repository",
        input: "I want to create an MCP server from the React repository"
      },
      {
        name: "Short Repository Name",
        input: "Make an MCP server for Express.js"
      },
      {
        name: "Ambiguous Request",
        input: "Help me build something cool"
      },
      {
        name: "Help Request",
        input: "What can you do?"
      }
    ];

    for (const scenario of scenarios) {
      console.log(`${colors.bold}${colors.system}Scenario: ${scenario.name}${colors.reset}`);
      console.log(`${colors.user}Input: "${scenario.input}"${colors.reset}`);

      const response = await this.simulateApiResponse(scenario.input);
      this.displayResponse(response);

      console.log(`${colors.dim}${'='.repeat(80)}${colors.reset}`);
    }
  }

  /**
   * Helper methods for demo simulation
   */
  containsGenerationIntent(message) {
    const generationKeywords = [
      'generate', 'create', 'make', 'build', 'mcp server',
      'server for', 'server from', 'repository', 'repo', 'github'
    ];
    return generationKeywords.some(keyword => message.includes(keyword));
  }

  containsRepositoryInfo(message) {
    return message.includes('github') || message.includes('repo') ||
           message.includes('/') || message.includes('.com');
  }

  extractRepositoryInfo(message) {
    // GitHub URL patterns
    const githubUrlMatch = message.match(/(?:https?:\/\/)?(?:www\.)?github\.com\/([^\/\s]+)\/([^\/\s]+)/i);
    if (githubUrlMatch) {
      const [, owner, repo] = githubUrlMatch;
      return {
        success: true,
        url: `https://github.com/${owner}/${repo}`,
        name: repo,
        description: `Repository: ${owner}/${repo}`
      };
    }

    // Popular repositories
    const popularRepos = {
      'react': { url: 'https://github.com/facebook/react', name: 'React', description: 'A declarative, efficient, and flexible JavaScript library for building user interfaces.' },
      'vue': { url: 'https://github.com/vuejs/vue', name: 'Vue.js', description: 'The progressive JavaScript framework.' },
      'express': { url: 'https://github.com/expressjs/express', name: 'Express.js', description: 'Fast, unopinionated, minimalist web framework for Node.js.' },
      'vscode': { url: 'https://github.com/microsoft/vscode', name: 'VS Code', description: 'Visual Studio Code - Open source code editor.' },
      'typescript': { url: 'https://github.com/microsoft/TypeScript', name: 'TypeScript', description: 'TypeScript extends JavaScript by adding types.' },
      'node': { url: 'https://github.com/nodejs/node', name: 'Node.js', description: 'Node.js JavaScript runtime.' }
    };

    for (const [key, repo] of Object.entries(popularRepos)) {
      if (message.toLowerCase().includes(key)) {
        return { success: true, ...repo };
      }
    }

    return { success: false };
  }

  generateUUID() {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
      const r = Math.random() * 16 | 0;
      const v = c == 'x' ? r : (r & 0x3 | 0x8);
      return v.toString(16);
    });
  }
}

// CLI Usage
async function main() {
  console.log(`${colors.bold}Starting MCP Everything Conversation Demo...${colors.reset}\n`);

  const demo = new ConversationDemo();
  await demo.startConversation();
}

// Additional command line options
if (process.argv.includes('--scenarios')) {
  const demo = new ConversationDemo();
  demo.runDemoScenarios().then(() => process.exit(0));
} else if (process.argv.includes('--help')) {
  console.log(`
MCP Everything Conversation Demo

Usage:
  node demo-conversation.js              # Interactive demo
  node demo-conversation.js --scenarios  # Run demo scenarios
  node demo-conversation.js --help       # Show this help

Environment Variables:
  API_URL=http://localhost:3000    # API endpoint (default: localhost:3000)
  DEMO_MODE=false                  # Set to false for live API testing

Interactive Commands:
  quit/exit  # End the demo
  clear      # Start a new conversation
  demo       # Run predefined scenarios
`);
  process.exit(0);
} else {
  main().catch(console.error);
}

module.exports = ConversationDemo;