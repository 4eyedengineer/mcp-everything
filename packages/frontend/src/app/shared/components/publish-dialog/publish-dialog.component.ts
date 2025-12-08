import { Component, Inject, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormBuilder, FormGroup, ReactiveFormsModule, Validators } from '@angular/forms';
import {
  MAT_DIALOG_DATA,
  MatDialogModule,
  MatDialogRef,
} from '@angular/material/dialog';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatSelectModule } from '@angular/material/select';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatChipsModule } from '@angular/material/chips';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { COMMA, ENTER, SPACE } from '@angular/cdk/keycodes';
import { MatChipInputEvent } from '@angular/material/chips';

export interface PublishDialogData {
  conversationId: string;
  name?: string;
  description?: string;
  tools?: { name: string; description: string }[];
  resources?: { name: string; description: string }[];
}

export interface PublishDialogResult {
  name: string;
  description: string;
  longDescription: string;
  category: string;
  tags: string[];
  visibility: 'public' | 'private' | 'unlisted';
}

interface CategoryOption {
  value: string;
  label: string;
  description: string;
}

@Component({
  selector: 'mcp-publish-dialog',
  standalone: true,
  imports: [
    CommonModule,
    ReactiveFormsModule,
    MatDialogModule,
    MatFormFieldModule,
    MatInputModule,
    MatSelectModule,
    MatButtonModule,
    MatIconModule,
    MatChipsModule,
    MatProgressSpinnerModule,
  ],
  templateUrl: './publish-dialog.component.html',
  styleUrls: ['./publish-dialog.component.scss'],
})
export class PublishDialogComponent implements OnInit {
  publishForm: FormGroup;
  tags: string[] = [];
  isSubmitting = false;

  readonly separatorKeyCodes = [ENTER, COMMA, SPACE] as const;

  readonly categories: CategoryOption[] = [
    { value: 'api', label: 'API Integration', description: 'Connect to external APIs and services' },
    { value: 'database', label: 'Database', description: 'Database connections and operations' },
    { value: 'utility', label: 'Utility', description: 'General purpose tools and utilities' },
    { value: 'ai', label: 'AI & ML', description: 'AI/ML models and integrations' },
    { value: 'devtools', label: 'Developer Tools', description: 'Development and debugging tools' },
    { value: 'communication', label: 'Communication', description: 'Email, chat, and messaging' },
    { value: 'storage', label: 'Storage', description: 'File and cloud storage' },
    { value: 'analytics', label: 'Analytics', description: 'Data analytics and reporting' },
    { value: 'other', label: 'Other', description: 'Other categories' },
  ];

  readonly visibilityOptions = [
    { value: 'public', label: 'Public', description: 'Visible to everyone in the marketplace' },
    { value: 'unlisted', label: 'Unlisted', description: 'Accessible via direct link only' },
    { value: 'private', label: 'Private', description: 'Only visible to you' },
  ];

  constructor(
    private fb: FormBuilder,
    private dialogRef: MatDialogRef<PublishDialogComponent>,
    @Inject(MAT_DIALOG_DATA) public data: PublishDialogData
  ) {
    this.publishForm = this.fb.group({
      name: [data.name || '', [Validators.required, Validators.minLength(3), Validators.maxLength(100)]],
      description: [data.description || '', [Validators.required, Validators.minLength(10), Validators.maxLength(500)]],
      longDescription: ['', [Validators.maxLength(5000)]],
      category: ['', [Validators.required]],
      visibility: ['public', [Validators.required]],
    });
  }

  ngOnInit(): void {
    // Pre-populate tags if tools/resources suggest some
    if (this.data.tools && this.data.tools.length > 0) {
      // Extract potential tags from tool names
      const toolTags = this.data.tools
        .map((t) => t.name.toLowerCase().replace(/_/g, '-'))
        .slice(0, 3);
      this.tags = [...new Set(toolTags)];
    }
  }

  addTag(event: MatChipInputEvent): void {
    const value = (event.value || '').trim().toLowerCase();

    if (value && !this.tags.includes(value) && this.tags.length < 10) {
      this.tags.push(value);
    }

    event.chipInput!.clear();
  }

  removeTag(tag: string): void {
    const index = this.tags.indexOf(tag);
    if (index >= 0) {
      this.tags.splice(index, 1);
    }
  }

  onCancel(): void {
    this.dialogRef.close();
  }

  onSubmit(): void {
    if (this.publishForm.valid) {
      const result: PublishDialogResult = {
        name: this.publishForm.value.name.trim(),
        description: this.publishForm.value.description.trim(),
        longDescription: this.publishForm.value.longDescription?.trim() || '',
        category: this.publishForm.value.category,
        tags: this.tags,
        visibility: this.publishForm.value.visibility,
      };
      this.dialogRef.close(result);
    } else {
      this.publishForm.markAllAsTouched();
    }
  }

  get nameError(): string {
    const control = this.publishForm.get('name');
    if (control?.hasError('required')) return 'Name is required';
    if (control?.hasError('minlength')) return 'Name must be at least 3 characters';
    if (control?.hasError('maxlength')) return 'Name must be less than 100 characters';
    return '';
  }

  get descriptionError(): string {
    const control = this.publishForm.get('description');
    if (control?.hasError('required')) return 'Description is required';
    if (control?.hasError('minlength')) return 'Description must be at least 10 characters';
    if (control?.hasError('maxlength')) return 'Description must be less than 500 characters';
    return '';
  }

  get categoryError(): string {
    const control = this.publishForm.get('category');
    if (control?.hasError('required')) return 'Category is required';
    return '';
  }
}
