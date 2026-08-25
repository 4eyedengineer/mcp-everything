import { Component, OnInit, signal, computed } from '@angular/core';
import { CommonModule, DatePipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { MatIconModule } from '@angular/material/icon';
import { MatTooltipModule } from '@angular/material/tooltip';
import { MatSnackBar, MatSnackBarModule } from '@angular/material/snack-bar';
import { ApiKeyService, ApiKeySummary, CreatedApiKey } from '../../../../core/services/api-key.service';

/**
 * Self-contained "API Key" account settings section.
 *
 * Drops into the Account page in place of the previous "Coming soon" stub.
 * Mimics the surrounding `.settings-section` / `.section-header` /
 * `.section-content` markup from account.component.html so it looks native,
 * but ships its own scoped styles so it can be embedded anywhere.
 *
 * Usage:
 *   import { ApiKeySectionComponent } from '.../api-key-section.component';
 *   <mcp-api-key-section></mcp-api-key-section>
 */
@Component({
  selector: 'mcp-api-key-section',
  standalone: true,
  imports: [CommonModule, FormsModule, MatIconModule, MatTooltipModule, MatSnackBarModule, DatePipe],
  templateUrl: './api-key-section.component.html',
  styleUrls: ['./api-key-section.component.scss'],
})
export class ApiKeySectionComponent implements OnInit {
  readonly MAX_ACTIVE_KEYS = 10;

  keys = signal<ApiKeySummary[]>([]);
  loading = signal(false);
  error = signal<string | null>(null);

  // Create flow
  isCreating = signal(false);
  newKeyName = signal('');
  createError = signal<string | null>(null);

  // Full plaintext key, shown exactly once right after creation.
  justCreatedKey = signal<CreatedApiKey | null>(null);
  copied = signal(false);

  // Per-key revoke-in-flight state, keyed by id.
  revokingIds = signal<Set<string>>(new Set());

  activeKeyCount = computed(() => this.keys().filter((k) => !k.revokedAt).length);
  hasReachedLimit = computed(() => this.activeKeyCount() >= this.MAX_ACTIVE_KEYS);

  constructor(
    private apiKeyService: ApiKeyService,
    private snackBar: MatSnackBar
  ) {}

  ngOnInit(): void {
    this.loadKeys();
  }

  loadKeys(): void {
    this.loading.set(true);
    this.error.set(null);
    this.apiKeyService.list().subscribe({
      next: (keys) => {
        this.keys.set(keys);
        this.loading.set(false);
      },
      error: (err: Error) => {
        this.error.set(err.message);
        this.loading.set(false);
      },
    });
  }

  startCreating(): void {
    this.isCreating.set(true);
    this.newKeyName.set('');
    this.createError.set(null);
  }

  cancelCreating(): void {
    this.isCreating.set(false);
    this.newKeyName.set('');
    this.createError.set(null);
  }

  submitCreate(): void {
    const name = this.newKeyName().trim();
    if (!name) {
      this.createError.set('Please give this key a name.');
      return;
    }

    this.createError.set(null);
    this.apiKeyService.create(name).subscribe({
      next: (created) => {
        this.justCreatedKey.set(created);
        this.copied.set(false);
        this.isCreating.set(false);
        this.newKeyName.set('');
        this.loadKeys();
      },
      error: (err: Error) => {
        this.createError.set(err.message);
      },
    });
  }

  dismissCreatedKey(): void {
    this.justCreatedKey.set(null);
    this.copied.set(false);
  }

  async copyKey(): Promise<void> {
    const created = this.justCreatedKey();
    if (!created) {
      return;
    }
    try {
      await navigator.clipboard.writeText(created.key);
      this.copied.set(true);
      this.snackBar.open('API key copied to clipboard', 'Dismiss', { duration: 3000 });
    } catch {
      this.snackBar.open('Could not copy automatically - please copy it manually', 'Dismiss', {
        duration: 4000,
      });
    }
  }

  revokeKey(key: ApiKeySummary): void {
    if (key.revokedAt) {
      return;
    }
    const confirmed = confirm(
      `Revoke "${key.name}"? Anything using this key will immediately lose access. This cannot be undone.`
    );
    if (!confirmed) {
      return;
    }

    const inFlight = new Set(this.revokingIds());
    inFlight.add(key.id);
    this.revokingIds.set(inFlight);

    this.apiKeyService.revoke(key.id).subscribe({
      next: () => {
        this.snackBar.open(`"${key.name}" has been revoked`, 'Dismiss', { duration: 3000 });
        this.loadKeys();
        this.clearRevoking(key.id);
      },
      error: (err: Error) => {
        this.snackBar.open(err.message, 'Dismiss', { duration: 4000 });
        this.clearRevoking(key.id);
      },
    });
  }

  isRevoking(id: string): boolean {
    return this.revokingIds().has(id);
  }

  private clearRevoking(id: string): void {
    const inFlight = new Set(this.revokingIds());
    inFlight.delete(id);
    this.revokingIds.set(inFlight);
  }
}
