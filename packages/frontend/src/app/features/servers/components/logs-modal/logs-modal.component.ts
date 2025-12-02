import { Component, Input, Output, EventEmitter, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { MatIconModule } from '@angular/material/icon';
import { MatButtonModule } from '@angular/material/button';
import { MatSelectModule } from '@angular/material/select';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';

import { HostedServer } from '../../../../core/services/hosting-api.service';
import { HostingApiService } from '../../../../core/services/hosting-api.service';

@Component({
  selector: 'mcp-logs-modal',
  standalone: true,
  imports: [
    CommonModule,
    FormsModule,
    MatIconModule,
    MatButtonModule,
    MatSelectModule,
    MatFormFieldModule,
    MatProgressSpinnerModule
  ],
  templateUrl: './logs-modal.component.html',
  styleUrls: ['./logs-modal.component.scss']
})
export class LogsModalComponent implements OnInit {
  @Input() server!: HostedServer;
  @Output() close = new EventEmitter<void>();

  logs: string[] = [];
  message = '';
  isLoading = true;
  error: string | null = null;
  lineCount = 100;

  lineCountOptions = [
    { value: 50, label: 'Last 50 lines' },
    { value: 100, label: 'Last 100 lines' },
    { value: 500, label: 'Last 500 lines' }
  ];

  constructor(private hostingApiService: HostingApiService) {}

  ngOnInit(): void {
    this.refreshLogs();
  }

  refreshLogs(): void {
    this.isLoading = true;
    this.error = null;

    this.hostingApiService.getLogs(this.server.serverId, this.lineCount).subscribe({
      next: (response) => {
        this.logs = response.logs;
        this.message = response.message;
        this.isLoading = false;
      },
      error: (err) => {
        this.error = err.error || 'Failed to load logs';
        this.isLoading = false;
      }
    });
  }

  downloadLogs(): void {
    const logContent = this.logs.join('\n');
    const blob = new Blob([logContent], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${this.server.serverId}-logs.txt`;
    a.click();
    URL.revokeObjectURL(url);
  }

  onOverlayClick(event: MouseEvent): void {
    if ((event.target as HTMLElement).classList.contains('modal-overlay')) {
      this.close.emit();
    }
  }

  onClose(): void {
    this.close.emit();
  }
}
