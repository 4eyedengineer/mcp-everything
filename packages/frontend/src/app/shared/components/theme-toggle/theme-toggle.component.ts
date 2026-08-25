import { Component, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { ThemeService, ThemeMode } from '../../../core/services/theme.service';

/**
 * Small segmented Light / Dark / System control, driven entirely by
 * ThemeService signals. Designed to slot into a preference row that looks
 * like the ones on the account page (see account.component.html's
 * `.preference-item` / `.preference-control` convention) - drop this
 * component into `.preference-control` in place of the disabled toggle
 * switch.
 *
 * Selector: `mcp-theme-toggle`
 */
@Component({
  selector: 'mcp-theme-toggle',
  standalone: true,
  imports: [CommonModule],
  template: `
    <div class="theme-toggle" role="radiogroup" aria-label="Theme">
      <button
        type="button"
        class="theme-toggle-option"
        role="radio"
        [attr.aria-checked]="mode() === 'light'"
        [class.active]="mode() === 'light'"
        (click)="select('light')">
        <svg class="theme-toggle-icon" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2">
          <circle cx="12" cy="12" r="4"></circle>
          <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41"></path>
        </svg>
        <span>Light</span>
      </button>
      <button
        type="button"
        class="theme-toggle-option"
        role="radio"
        [attr.aria-checked]="mode() === 'dark'"
        [class.active]="mode() === 'dark'"
        (click)="select('dark')">
        <svg class="theme-toggle-icon" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"></path>
        </svg>
        <span>Dark</span>
      </button>
      <button
        type="button"
        class="theme-toggle-option"
        role="radio"
        [attr.aria-checked]="mode() === 'system'"
        [class.active]="mode() === 'system'"
        (click)="select('system')">
        <svg class="theme-toggle-icon" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2">
          <rect x="2" y="4" width="20" height="13" rx="2"></rect>
          <path d="M8 21h8M12 17v4"></path>
        </svg>
        <span>System</span>
      </button>
    </div>
  `,
  styleUrl: './theme-toggle.component.scss'
})
export class ThemeToggleComponent {
  private readonly themeService = inject(ThemeService);

  readonly mode = this.themeService.mode;

  select(mode: ThemeMode): void {
    this.themeService.setMode(mode);
  }
}
