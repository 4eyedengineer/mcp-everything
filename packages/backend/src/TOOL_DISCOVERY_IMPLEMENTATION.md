# Tool Discovery Service Implementation

## Overview

The Tool Discovery Service is an AI-powered system that analyzes GitHub repositories to identify and generate MCP (Model Context Protocol) tools. It uses Claude AI to intelligently discover repository-specific tools through semantic understanding rather than pattern matching.

## Core Architecture

### Judge LLM Pattern
The service implements a multi-stage AI validation system:

1. **Generation Pass**: AI analyzes repository data and generates potential tools
2. **Judge Pass**: AI validates each tool for quality and usefulness
3. **Regeneration Pass**: If validation fails, AI regenerates with feedback
4. **No Fallbacks**: Pure AI reasoning - no templates or generic fallbacks

### Service Structure

```typescript
@Injectable()
export class ToolDiscoveryService {
  // Core discovery methods
  discoverTools(analysis: GitHubAnalysis): Promise<ToolDiscoveryResult>
  generateToolFromCode(code: string, context: RepositoryContext): Promise<McpTool[]>
  extractToolsFromReadme(readme: string, context: RepositoryContext): Promise<McpTool[]>
  mapApiToTools(apiPatterns: ApiPattern[], context: RepositoryContext): Promise<McpTool[]>
  judgeToolQuality(tool: Partial<McpTool>, context: RepositoryContext): Promise<AiQualityJudgment>
}
```

## Implementation Details

### 1. Repository Context Analysis
```typescript
interface RepositoryContext {
  primaryLanguage: string;
  frameworks: string[];
  repositoryType: 'library' | 'application' | 'tool' | 'service' | 'other';
  complexity: 'simple' | 'medium' | 'complex';
  domain: string; // web, mobile, cli, data, ml, etc.
}
```

### 2. Tool Quality Assessment
```typescript
interface ToolQuality {
  usefulness: number;      // 0-1 scale
  specificity: number;     // How repository-specific
  implementability: number; // How feasible to implement
  uniqueness: number;      // How unique/valuable
  overallScore: number;    // Combined score
  reasoning: string;       // AI's assessment reasoning
}
```

### 3. Multi-Method Discovery
- **Code Analysis**: Analyzes source files to infer tools
- **README Extraction**: Finds tools mentioned in documentation
- **API Mapping**: Converts API endpoints to MCP tools
- **Comprehensive Analysis**: Holistic repository understanding

## AI Prompting Strategy

### Structured Prompts
- Context-aware prompts with repository information
- Chain-of-thought reasoning for complex analysis
- JSON-only responses for reliable parsing
- Examples and constraints for consistent output

### Prompt Templates
1. **Code Analysis Prompt**: Analyzes code snippets for tool opportunities
2. **README Analysis Prompt**: Extracts tools from documentation
3. **API Mapping Prompt**: Converts endpoints to tools
4. **Quality Judge Prompt**: Evaluates tool usefulness
5. **Regeneration Prompt**: Improves tools based on feedback

## Generated Tool Structure

```typescript
interface McpTool {
  name: string;                    // snake_case format
  description: string;             // Clear, actionable description
  category: ToolCategory;          // data, api, file, utility, etc.
  inputSchema: JsonSchema;         // JSON Schema for inputs
  implementationHints: ImplementationHints;
  quality: ToolQuality;
}
```

### Tool Categories
- `data`: Data extraction/manipulation
- `api`: API interaction tools
- `file`: File system operations
- `utility`: General utility functions
- `analysis`: Code/repository analysis
- `build`: Build/deployment tools
- `test`: Testing utilities
- `documentation`: Documentation generation
- `search`: Search/query operations
- `transform`: Data transformation

## API Integration

### New Endpoint: `/discover-tools`
```bash
POST /discover-tools
{
  "githubUrl": "https://github.com/facebook/react"
}
```

Response includes:
- Repository metadata
- Discovered tools with quality scores
- AI reasoning and processing metadata
- Discovery method breakdown

### Example Response
```json
{
  "success": true,
  "repository": {
    "name": "react",
    "fullName": "facebook/react",
    "description": "A declarative, efficient, and flexible JavaScript library for building user interfaces.",
    "url": "https://github.com/facebook/react"
  },
  "toolDiscovery": {
    "success": true,
    "tools": [
      {
        "name": "analyze_component",
        "description": "Analyze React component structure, props, and hooks usage",
        "category": "analysis",
        "inputSchema": {
          "type": "object",
          "properties": {
            "componentPath": {
              "type": "string",
              "description": "Path to React component file"
            }
          },
          "required": ["componentPath"]
        },
        "quality": {
          "usefulness": 0.9,
          "specificity": 0.8,
          "implementability": 0.85,
          "uniqueness": 0.7,
          "overallScore": 0.81
        }
      }
    ],
    "metadata": {
      "processingTime": 2340,
      "iterationCount": 3,
      "qualityThreshold": 0.7,
      "aiReasoning": "Generated React-specific tools based on component analysis patterns"
    }
  }
}
```

## Quality Assurance

### Multi-Stage Validation
1. **Syntax Validation**: Ensures proper tool structure
2. **AI Quality Judgment**: Evaluates usefulness and specificity
3. **Iterative Improvement**: Regenerates poor-quality tools
4. **Repository Specificity**: Prioritizes unique over generic tools

### Thresholds & Limits
- Quality threshold: 0.7/1.0 minimum score
- Max iterations: 5 per tool
- Max tools per category: 5
- Processing timeout: Configurable per repository

## Files Created

### Core Implementation
- `/src/tool-discovery.service.ts` - Main service implementation
- `/src/types/tool-discovery.types.ts` - TypeScript type definitions

### Integration
- Updated `/src/app.module.ts` - Added service provider and API endpoint
- Updated `/src/conversation.service.ts` - Added public AI access method

### Testing
- `/src/scripts/test-tool-discovery.ts` - Comprehensive test script
- Updated `package.json` - Added npm test scripts

## Usage Examples

### Repository-Specific Tools for React
- `analyze_component`: Parse React component structure
- `extract_props`: Extract component props and types
- `find_hooks`: Locate and analyze custom React hooks
- `check_dependencies`: Analyze React project dependencies

### Repository-Specific Tools for Express API
- `call_endpoint`: Make authenticated API calls
- `validate_routes`: Check route definitions
- `analyze_middleware`: Examine middleware stack
- `test_endpoints`: Generate API test cases

## Technical Benefits

1. **AI-Native**: Pure semantic understanding vs pattern matching
2. **Repository-Specific**: Generates unique tools per codebase
3. **Quality Focused**: Multi-stage validation ensures usefulness
4. **Scalable**: Works with any repository type/language
5. **Extensible**: Easy to add new discovery methods

## Future Enhancements

1. **Caching**: Cache analysis results for faster subsequent runs
2. **Learning**: Improve prompts based on usage patterns
3. **Templates**: Smart template suggestions for common patterns
4. **Batch Processing**: Analyze multiple repositories simultaneously
5. **Custom Models**: Support for different AI models/providers

## Configuration

```typescript
interface DiscoveryConfig {
  maxIterations: number;        // Default: 5
  qualityThreshold: number;     // Default: 0.7
  maxToolsPerCategory: number;  // Default: 5
  preferredCategories: ToolCategory[];
  complexityBias: 'simple' | 'balanced' | 'complex';
}
```

The tool discovery service represents the core AI differentiation of MCP Everything - moving beyond generic template generation to intelligent, context-aware tool creation that truly understands repository semantics.