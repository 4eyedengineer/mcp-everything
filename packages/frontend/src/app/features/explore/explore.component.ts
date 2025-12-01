import { Component } from '@angular/core';
import { CommonModule } from '@angular/common';
import { RouterModule } from '@angular/router';
import { MatIconModule } from '@angular/material/icon';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';

interface McpServer {
  id: string;
  name: string;
  description: string;
  source: string;
  createdAt: Date;
  tags: string[];
  downloadCount: number;
}

@Component({
  selector: 'mcp-explore',
  standalone: true,
  imports: [
    CommonModule,
    RouterModule,
    MatIconModule,
    MatProgressSpinnerModule
  ],
  templateUrl: './explore.component.html',
  styleUrls: ['./explore.component.scss']
})
export class ExploreComponent {
  isLoading = false;

  // Placeholder data - will be replaced with actual API calls
  servers: McpServer[] = [
    {
      id: '1',
      name: 'Express.js MCP Server',
      description: 'MCP server for Express.js framework with routing, middleware, and HTTP server tools',
      source: 'GitHub: expressjs/express',
      createdAt: new Date('2024-10-01'),
      tags: ['JavaScript', 'Node.js', 'Web Framework'],
      downloadCount: 145
    },
    {
      id: '2',
      name: 'React MCP Server',
      description: 'MCP server for React library with component lifecycle, hooks, and state management tools',
      source: 'GitHub: facebook/react',
      createdAt: new Date('2024-10-05'),
      tags: ['JavaScript', 'React', 'UI Library'],
      downloadCount: 230
    },
    {
      id: '3',
      name: 'TypeScript MCP Server',
      description: 'MCP server for TypeScript with type system, compiler API, and language service tools',
      source: 'GitHub: microsoft/typescript',
      createdAt: new Date('2024-10-07'),
      tags: ['TypeScript', 'Language', 'Compiler'],
      downloadCount: 89
    }
  ];

  downloadServer(server: McpServer): void {
    console.log('Downloading server:', server.name);
    // TODO: Implement actual download logic
  }

  viewDetails(server: McpServer): void {
    console.log('Viewing details for:', server.name);
    // TODO: Implement navigation to server details
  }
}
