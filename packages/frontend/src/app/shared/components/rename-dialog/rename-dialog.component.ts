import { Component, Inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { MAT_DIALOG_DATA, MatDialogModule, MatDialogRef } from '@angular/material/dialog';
import { MatButtonModule } from '@angular/material/button';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';

/**
 * Data passed to the rename dialog.
 */
export interface RenameDialogData {
  title: string;
  label?: string;
  value: string;
}

/**
 * Single-field text input dialog, used in place of the native
 * `window.prompt()` so it matches app theming and is keyboard/focus-trapped.
 *
 * Closes with the trimmed, non-empty new value, or `undefined` if cancelled.
 */
@Component({
  selector: 'mcp-rename-dialog',
  standalone: true,
  imports: [
    CommonModule,
    FormsModule,
    MatDialogModule,
    MatButtonModule,
    MatFormFieldModule,
    MatInputModule
  ],
  templateUrl: './rename-dialog.component.html',
  styleUrls: ['./rename-dialog.component.scss']
})
export class RenameDialogComponent {
  value: string;

  constructor(
    @Inject(MAT_DIALOG_DATA) public data: RenameDialogData,
    private dialogRef: MatDialogRef<RenameDialogComponent, string>
  ) {
    this.value = data.value ?? '';
  }

  onCancel(): void {
    this.dialogRef.close();
  }

  onSave(): void {
    const trimmed = this.value.trim();
    if (trimmed) {
      this.dialogRef.close(trimmed);
    }
  }
}
