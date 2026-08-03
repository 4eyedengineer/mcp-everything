import { Component, EventEmitter, HostListener, Input, OnInit, Output, computed, signal } from '@angular/core';
import { CommonModule, DatePipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { MatIconModule } from '@angular/material/icon';
import { MatTooltipModule } from '@angular/material/tooltip';

import {
  CreateHostedServerApiKeyRequest,
  CreatedHostedServerApiKey,
  HostedServer,
  HostedServerApiKey,
  HostingApiService
} from '../../../../core/services/hosting-api.service';
import { ConfirmModalComponent } from '../confirm-modal/confirm-modal.component';
import { buildClaudeDesktopConfigJson } from '../../../../shared/utils/claude-desktop-config.util';

/** Preset lifetimes offered in the create form. `null` means "never expires". */
interface ExpiryOption {
  label: string;
  days: number | null;
}

/**
 * Per-hosted-server API key management: list, create, revoke, and - the
 * critical interaction - the one-time plaintext reveal at creation.
 *
 * Lives on the "My Servers" surface (opened from `ServerManagementCardComponent`)
 * rather than the account page, because these keys are scoped to one hosted
 * server, not to the user - see `HostedServerApiKeyService` on the backend.
 *
 * The plaintext key from a create response is held ONLY in `justCreated`, and
 * only until the user explicitly acknowledges and dismisses it via
 * `acknowledgeAndDismiss()`, which clears it. It is never written anywhere
 * else (no console.log, no query string) and this component does not persist
 * it across reloads.
 */
@Component({
  selector: 'mcp-api-keys-modal',
  standalone: true,
  imports: [CommonModule, FormsModule, MatIconModule, MatTooltipModule, DatePipe, ConfirmModalComponent],
  templateUrl: './api-keys-modal.component.html',
  styleUrls: ['./api-keys-modal.component.scss']
})
export class ApiKeysModalComponent implements OnInit {
  @Input() server!: HostedServer;
  @Output() close = new EventEmitter<void>();

  /**
   * Mirrors `HostedServerApiKeyService.MAX_ACTIVE_KEYS_PER_SERVER` on the
   * backend, which is the actual enforcement point - this constant only
   * drives when the UI surfaces the cap ahead of a 400 from the create call.
   */
  readonly MAX_ACTIVE_KEYS = 5;

  readonly expiryOptions: ExpiryOption[] = [
    { label: 'Never expires', days: null },
    { label: '30 days', days: 30 },
    { label: '90 days', days: 90 },
    { label: '1 year', days: 365 }
  ];

  keys = signal<HostedServerApiKey[]>([]);
  loading = signal(true);
  error = signal<string | null>(null);

  // Create flow
  isCreating = signal(false);
  newLabel = signal('');
  newExpiryDays = signal<number | null>(null);
  createSubmitting = signal(false);
  createError = signal<string | null>(null);

  // One-time secret reveal. Cleared by acknowledgeAndDismiss() - nothing else
  // in this component retains the plaintext once that runs.
  justCreated = signal<CreatedHostedServerApiKey | null>(null);
  acknowledged = signal(false);
  copiedKey = signal(false);
  copiedConfig = signal(false);
  copyKeyError = signal<string | null>(null);
  copyConfigError = signal<string | null>(null);

  // Revoke flow
  revokeTarget = signal<HostedServerApiKey | null>(null);
  revokingIds = signal<Set<string>>(new Set());
  revokeError = signal<string | null>(null);

  activeCount = computed(() => this.keys().filter((k) => k.active).length);
  atCap = computed(() => this.activeCount() >= this.MAX_ACTIVE_KEYS);
  /** True while the one-time secret banner is showing - gates every dismissal path. */
  showingSecret = computed(() => this.justCreated() !== null);

  constructor(private hostingApi: HostingApiService) {}

  ngOnInit(): void {
    this.loadKeys();
  }

  loadKeys(): void {
    this.loading.set(true);
    this.error.set(null);
    this.hostingApi.listServerApiKeys(this.server.serverId).subscribe({
      next: (res) => {
        this.keys.set(res.apiKeys);
        this.loading.set(false);
      },
      error: (err: { error?: string }) => {
        this.error.set(err?.error || 'Failed to load API keys');
        this.loading.set(false);
      }
    });
  }

  statusLabel(key: HostedServerApiKey): 'Active' | 'Revoked' | 'Expired' {
    if (key.active) return 'Active';
    return key.revokedAt ? 'Revoked' : 'Expired';
  }

  startCreating(): void {
    if (this.atCap()) return;
    this.isCreating.set(true);
    this.newLabel.set('');
    this.newExpiryDays.set(null);
    this.createError.set(null);
  }

  cancelCreating(): void {
    this.isCreating.set(false);
    this.newLabel.set('');
    this.createError.set(null);
  }

  submitCreate(): void {
    const label = this.newLabel().trim();
    if (!label) {
      this.createError.set('A label is required, e.g. "ci-runner" or "laptop".');
      return;
    }

    this.createError.set(null);
    this.createSubmitting.set(true);

    const request: CreateHostedServerApiKeyRequest = { label };
    const expiresInDays = this.newExpiryDays();
    if (expiresInDays !== null) {
      request.expiresInDays = expiresInDays;
    }

    this.hostingApi.createServerApiKey(this.server.serverId, request).subscribe({
      next: (created) => {
        this.createSubmitting.set(false);
        this.isCreating.set(false);
        this.newLabel.set('');
        this.justCreated.set(created);
        this.acknowledged.set(false);
        this.copiedKey.set(false);
        this.copiedConfig.set(false);
        this.copyKeyError.set(null);
        this.copyConfigError.set(null);
        this.loadKeys();
      },
      error: (err: { error?: string }) => {
        this.createSubmitting.set(false);
        this.createError.set(err?.error || 'Failed to create API key');
      }
    });
  }

  async copySecretKey(): Promise<void> {
    const created = this.justCreated();
    if (!created) return;
    try {
      await navigator.clipboard.writeText(created.key);
      this.copiedKey.set(true);
      this.copyKeyError.set(null);
    } catch {
      this.copyKeyError.set("Couldn't copy automatically - select the text above and copy it manually.");
    }
  }

  /** Copies a complete, ready-to-paste Claude Desktop config containing the real key. */
  async copyConfigWithKey(): Promise<void> {
    const created = this.justCreated();
    if (!created) return;
    try {
      const json = buildClaudeDesktopConfigJson(this.server.serverName, this.server.serverId, created.key);
      await navigator.clipboard.writeText(json);
      this.copiedConfig.set(true);
      this.copyConfigError.set(null);
    } catch {
      this.copyConfigError.set("Couldn't copy the config automatically - please try again.");
    }
  }

  /**
   * The only way the secret banner goes away. Requires the explicit
   * acknowledgement checkbox, and clears the plaintext key out of component
   * state - it is not retained anywhere after this call.
   */
  acknowledgeAndDismiss(): void {
    if (!this.acknowledged()) return;
    this.justCreated.set(null);
    this.acknowledged.set(false);
    this.copiedKey.set(false);
    this.copiedConfig.set(false);
    this.copyKeyError.set(null);
    this.copyConfigError.set(null);
  }

  requestRevoke(key: HostedServerApiKey): void {
    this.revokeTarget.set(key);
    this.revokeError.set(null);
  }

  cancelRevoke(): void {
    this.revokeTarget.set(null);
  }

  confirmRevoke(): void {
    const target = this.revokeTarget();
    if (!target) return;

    const inFlight = new Set(this.revokingIds());
    inFlight.add(target.id);
    this.revokingIds.set(inFlight);

    this.hostingApi.revokeServerApiKey(this.server.serverId, target.id).subscribe({
      next: () => {
        this.revokeTarget.set(null);
        this.clearRevoking(target.id);
        this.loadKeys();
      },
      error: (err: { error?: string }) => {
        this.revokeError.set(err?.error || 'Failed to revoke API key');
        this.revokeTarget.set(null);
        this.clearRevoking(target.id);
      }
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

  /**
   * Backdrop click closes the modal - unless the one-time secret is showing,
   * in which case a stray click must not silently discard it.
   */
  onOverlayClick(event: MouseEvent): void {
    if (this.showingSecret()) return;
    if ((event.target as HTMLElement).classList.contains('modal-overlay')) {
      this.close.emit();
    }
  }

  onClose(): void {
    if (this.showingSecret()) return;
    this.close.emit();
  }

  /** Escape must not discard the one-time secret either. */
  @HostListener('document:keydown.escape')
  onEscape(): void {
    if (this.showingSecret()) return;
    this.close.emit();
  }
}
