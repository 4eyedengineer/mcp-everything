import { Component, Inject, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormBuilder, FormGroup, ReactiveFormsModule, Validators } from '@angular/forms';
import {
  MAT_DIALOG_DATA,
  MatDialogModule,
  MatDialogRef
} from '@angular/material/dialog';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import {
  HostingApiService,
  DeployToCloudResponse
} from '../../../../core/services/hosting-api.service';

/**
 * Tool definition
 */
export interface DeployModalTool {
  name: string;
  description: string;
}

/**
 * Environment variable definition
 */
export interface DeployModalEnvVar {
  name: string;
  required: boolean;
  description?: string;
}

/**
 * Data passed to the deploy modal
 */
export interface DeployModalData {
  conversationId: string;
  serverName: string;
  description: string;
  tools: DeployModalTool[];
  envVars: DeployModalEnvVar[];
}

/**
 * Result returned when modal closes successfully
 */
export interface DeployModalResult {
  success: boolean;
  serverId?: string;
  endpointUrl?: string;
  error?: string;
}

@Component({
  selector: 'mcp-deploy-modal',
  standalone: true,
  imports: [
    CommonModule,
    ReactiveFormsModule,
    MatDialogModule,
    MatFormFieldModule,
    MatInputModule,
    MatButtonModule,
    MatIconModule,
    MatProgressSpinnerModule
  ],
  templateUrl: './deploy-modal.component.html',
  styleUrls: ['./deploy-modal.component.scss']
})
export class DeployModalComponent implements OnInit {
  form!: FormGroup;
  isSubmitting = false;
  error: string | null = null;

  constructor(
    @Inject(MAT_DIALOG_DATA) public data: DeployModalData,
    private dialogRef: MatDialogRef<DeployModalComponent, DeployModalResult>,
    private fb: FormBuilder,
    private hostingApiService: HostingApiService
  ) {}

  ngOnInit(): void {
    this.buildForm();
  }

  /**
   * Build the form with server info and env var fields
   */
  private buildForm(): void {
    const formConfig: Record<string, unknown> = {
      serverName: [this.data.serverName || '', [Validators.required, Validators.maxLength(100)]],
      description: [this.data.description || '', [Validators.maxLength(500)]]
    };

    // Add env var fields dynamically
    for (const envVar of this.data.envVars) {
      const validators = envVar.required ? [Validators.required] : [];
      formConfig[`env_${envVar.name}`] = ['', validators];
    }

    this.form = this.fb.group(formConfig);
  }

  /**
   * Get form control for an env var
   */
  getEnvVarControl(envVarName: string) {
    return this.form.get(`env_${envVarName}`);
  }

  /**
   * Check if form has env vars
   */
  get hasEnvVars(): boolean {
    return this.data.envVars.length > 0;
  }

  /**
   * Submit the form and deploy
   */
  async onSubmit(): Promise<void> {
    if (this.form.invalid || this.isSubmitting) {
      return;
    }

    this.isSubmitting = true;
    this.error = null;

    // Build env vars object
    const envVars: Record<string, string> = {};
    for (const envVar of this.data.envVars) {
      const value = this.form.get(`env_${envVar.name}`)?.value;
      if (value) {
        envVars[envVar.name] = value;
      }
    }

    this.hostingApiService
      .deployToCloud(this.data.conversationId, {
        serverName: this.form.get('serverName')?.value,
        description: this.form.get('description')?.value,
        envVars
      })
      .subscribe({
        next: (response: DeployToCloudResponse) => {
          this.isSubmitting = false;
          if (response.success) {
            this.dialogRef.close({
              success: true,
              serverId: response.serverId,
              endpointUrl: response.endpointUrl
            });
          } else {
            this.error = response.error || 'Deployment failed. Please try again.';
          }
        },
        error: (err) => {
          this.isSubmitting = false;
          this.error = err.error || 'An unexpected error occurred. Please try again.';
        }
      });
  }

  /**
   * Cancel and close the modal
   */
  onCancel(): void {
    this.dialogRef.close();
  }
}
