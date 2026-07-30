import { Injectable } from '@angular/core';
import { MatSnackBar, MatSnackBarConfig, MatSnackBarRef } from '@angular/material/snack-bar';
import { Observable, Subject } from 'rxjs';

export interface Notification {
  id: string;
  type: 'success' | 'error' | 'warning' | 'info';
  title: string;
  message?: string;
  action?: {
    label: string;
    handler: () => void;
  };
  duration?: number;
  persistent?: boolean;
  timestamp: Date;
}

@Injectable({
  providedIn: 'root'
})
export class NotificationService {
  private notificationsSubject = new Subject<Notification>();
  public notifications$ = this.notificationsSubject.asObservable();

  private activeNotifications: Map<string, MatSnackBarRef<any>> = new Map();

  // Dedupe identical toasts fired in quick succession (e.g. two background
  // boot requests failing with the same generic message at nearly the same
  // time) so the user sees one toast instead of it flickering/reopening.
  // Maps a "type|title|message" signature to { id, shownAt } for the most
  // recent notification with that signature.
  private recentSignatures: Map<string, { id: string; shownAt: number }> = new Map();
  private static readonly DEDUPE_WINDOW_MS = 4000;

  constructor(private snackBar: MatSnackBar) {}

  /**
   * Show success notification
   */
  success(title: string, message?: string, action?: { label: string; handler: () => void }): string {
    return this.show({
      type: 'success',
      title,
      message,
      action,
      duration: 5000
    });
  }

  /**
   * Show error notification.
   *
   * Auto-dismisses after 8s by default (with a "Close" action for anyone
   * who wants it gone sooner). Pass `{ persistent: true }` ONLY for cases
   * where the toast must stay until the user acts on it - e.g. a session
   * that has genuinely expired mid-use. Do not default to persistent for
   * routine request failures; a stuck toast blocks pointer events over
   * whatever it overlaps (the nav bar on mobile).
   */
  error(
    title: string,
    message?: string,
    action?: { label: string; handler: () => void },
    options?: { persistent?: boolean }
  ): string {
    return this.show({
      type: 'error',
      title,
      message,
      action,
      duration: 8000,
      persistent: options?.persistent ?? false
    });
  }

  /**
   * Show warning notification
   */
  warning(title: string, message?: string, action?: { label: string; handler: () => void }): string {
    return this.show({
      type: 'warning',
      title,
      message,
      action,
      duration: 6000
    });
  }

  /**
   * Show info notification
   */
  info(title: string, message?: string, action?: { label: string; handler: () => void }): string {
    return this.show({
      type: 'info',
      title,
      message,
      action,
      duration: 4000
    });
  }

  /**
   * Show custom notification
   */
  show(options: Partial<Notification>): string {
    const type = options.type ?? 'info';
    const title = options.title ?? '';
    const signature = `${type}|${title}|${options.message ?? ''}`;

    const existing = this.recentSignatures.get(signature);
    if (existing) {
      const stillActive = this.activeNotifications.has(existing.id);
      const withinDedupeWindow = Date.now() - existing.shownAt < NotificationService.DEDUPE_WINDOW_MS;
      if (stillActive || withinDedupeWindow) {
        // Same type/title/message already showing (or just shown) - skip
        // opening a duplicate toast on top of/right after it.
        return existing.id;
      }
    }

    const id = this.generateId();
    const notification: Notification = {
      id,
      type: 'info',
      title: '',
      duration: 4000,
      timestamp: new Date(),
      ...options
    };

    this.recentSignatures.set(signature, { id, shownAt: Date.now() });

    // Build display message
    const displayMessage = notification.message
      ? `${notification.title}: ${notification.message}`
      : notification.title;

    // Configure snackbar
    const config: MatSnackBarConfig = {
      duration: notification.persistent ? undefined : notification.duration,
      horizontalPosition: 'right',
      verticalPosition: 'top',
      panelClass: [`notification-${notification.type}`]
    };

    // Show snackbar
    const snackBarRef = notification.action
      ? this.snackBar.open(displayMessage, notification.action.label, config)
      : this.snackBar.open(displayMessage, 'Close', config);

    // Handle action
    if (notification.action) {
      snackBarRef.onAction().subscribe(() => {
        notification.action!.handler();
      });
    }

    // Track active notification
    this.activeNotifications.set(id, snackBarRef);

    // Clean up when dismissed
    snackBarRef.afterDismissed().subscribe(() => {
      this.activeNotifications.delete(id);
    });

    // Emit notification
    this.notificationsSubject.next(notification);

    return id;
  }

  /**
   * Dismiss notification by ID
   */
  dismiss(id: string): void {
    const snackBarRef = this.activeNotifications.get(id);
    if (snackBarRef) {
      snackBarRef.dismiss();
      this.activeNotifications.delete(id);
    }
  }

  /**
   * Dismiss all notifications
   */
  dismissAll(): void {
    this.snackBar.dismiss();
    this.activeNotifications.clear();
  }

  /**
   * Show loading notification
   */
  showLoading(message: string = 'Loading...'): string {
    return this.show({
      type: 'info',
      title: message,
      persistent: true
    });
  }

  /**
   * Update existing notification
   */
  update(id: string, updates: Partial<Notification>): void {
    this.dismiss(id);
    this.show({ id, ...updates });
  }

  /**
   * Show progress notification
   */
  showProgress(title: string, progress: number): string {
    const message = `${Math.round(progress)}% complete`;
    return this.show({
      type: 'info',
      title,
      message,
      persistent: true
    });
  }

  /**
   * Show API error notification
   */
  showApiError(error: any): string {
    const title = 'Request Failed';
    const message = error?.message || error?.error?.message || 'An unexpected error occurred';

    return this.error(title, message, {
      label: 'Retry',
      handler: () => {
        // Emit retry event - components can listen to this
        this.notificationsSubject.next({
          id: this.generateId(),
          type: 'info',
          title: 'Retry requested',
          timestamp: new Date()
        });
      }
    });
  }

  /**
   * Show generation status notifications
   */
  showGenerationStatus(status: string, details?: string): string {
    const statusMessages: Record<string, { type: Notification['type']; title: string }> = {
      'started': { type: 'info', title: 'Generation Started' },
      'analyzing': { type: 'info', title: 'Analyzing Source' },
      'generating': { type: 'info', title: 'Generating Code' },
      'building': { type: 'info', title: 'Building Server' },
      'validating': { type: 'info', title: 'Validating Code' },
      'deploying': { type: 'info', title: 'Deploying Server' },
      'completed': { type: 'success', title: 'Generation Complete' },
      'failed': { type: 'error', title: 'Generation Failed' }
    };

    const config = statusMessages[status] || { type: 'info', title: status };

    return this.show({
      type: config.type,
      title: config.title,
      message: details,
      duration: config.type === 'error' ? 8000 : 4000
    });
  }

  /**
   * Show deployment notifications
   */
  showDeploymentStatus(status: string, url?: string): string {
    switch (status) {
      case 'success':
        return this.success('Deployment Successful', url ? `Available at: ${url}` : undefined,
          url ? { label: 'Open', handler: () => window.open(url, '_blank') } : undefined);

      case 'failed':
        return this.error('Deployment Failed', 'Please check the logs for details');

      case 'pending':
        return this.info('Deployment Started', 'Your server is being deployed...');

      default:
        return this.info('Deployment Status', status);
    }
  }

  /**
   * Show validation notifications
   */
  showValidationResults(results: { passed: boolean; errors: string[]; warnings: string[] }): void {
    if (results.passed) {
      this.success('Validation Passed', 'Your MCP server is ready to deploy');
    } else {
      this.error('Validation Failed', `${results.errors.length} error(s) found`);
    }

    // Show warnings separately
    results.warnings.forEach(warning => {
      this.warning('Validation Warning', warning);
    });
  }

  /**
   * Generate unique ID
   */
  private generateId(): string {
    return `notification-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  }

  /**
   * Get notification icon for type
   */
  getNotificationIcon(type: Notification['type']): string {
    const icons: Record<Notification['type'], string> = {
      success: 'check_circle',
      error: 'error',
      warning: 'warning',
      info: 'info'
    };
    return icons[type];
  }

  /**
   * Clear old notifications (for cleanup)
   */
  clearOldNotifications(olderThanMinutes: number = 30): void {
    const cutoff = new Date(Date.now() - olderThanMinutes * 60 * 1000);
    // This would require implementing a notification history store
    // For now, just dismiss all active notifications
    this.dismissAll();
  }
}