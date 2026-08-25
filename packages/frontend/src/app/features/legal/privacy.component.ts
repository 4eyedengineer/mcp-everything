import { Component } from '@angular/core';
import { CommonModule } from '@angular/common';
import { RouterModule } from '@angular/router';
import { ThemeToggleComponent } from '../../shared/components/theme-toggle/theme-toggle.component';

/**
 * Public Privacy Policy page, served at `/privacy`.
 *
 * See TermsComponent for why this page exists: it's the other half of the
 * registration form's required consent link, which previously pointed at a
 * route that fell through to the wildcard redirect.
 */
@Component({
  selector: 'mcp-privacy',
  standalone: true,
  imports: [CommonModule, RouterModule, ThemeToggleComponent],
  templateUrl: './privacy.component.html',
  styleUrls: ['./legal-page.scss'],
})
export class PrivacyComponent {
  readonly lastUpdated = 'August 25, 2026';
}
