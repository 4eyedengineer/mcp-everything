import { Component, Input, Output, EventEmitter } from '@angular/core';
import { CommonModule } from '@angular/common';
import { MatCardModule } from '@angular/material/card';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatChipsModule } from '@angular/material/chips';
import { MatTooltipModule } from '@angular/material/tooltip';

/**
 * Tool definition for display
 */
export interface ServerTool {
  name: string;
  description: string;
}

/**
 * Environment variable definition
 */
export interface ServerEnvVar {
  name: string;
  required: boolean;
  description?: string;
}

@Component({
  selector: 'mcp-server-card',
  standalone: true,
  imports: [
    CommonModule,
    MatCardModule,
    MatButtonModule,
    MatIconModule,
    MatChipsModule,
    MatTooltipModule
  ],
  templateUrl: './server-card.component.html',
  styleUrls: ['./server-card.component.scss']
})
export class ServerCardComponent {
  @Input() serverName = 'MCP Server';
  @Input() description = '';
  @Input() tools: ServerTool[] = [];
  @Input() envVars: ServerEnvVar[] = [];
  @Input() conversationId = '';
  @Input() isDeploying = false;

  @Output() download = new EventEmitter<void>();
  @Output() hostOnCloud = new EventEmitter<void>();

  /**
   * Get visible tools (first 3)
   */
  get visibleTools(): ServerTool[] {
    return this.tools.slice(0, 3);
  }

  /**
   * Get count of additional tools
   */
  get additionalToolsCount(): number {
    return Math.max(0, this.tools.length - 3);
  }

  /**
   * Check if there are required env vars
   */
  get hasRequiredEnvVars(): boolean {
    return this.envVars.some((v) => v.required);
  }

  onDownload(): void {
    this.download.emit();
  }

  onHostOnCloud(): void {
    this.hostOnCloud.emit();
  }
}
