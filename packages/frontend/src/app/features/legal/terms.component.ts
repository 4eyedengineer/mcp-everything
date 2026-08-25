import { Component } from '@angular/core';
import { CommonModule } from '@angular/common';
import { RouterModule } from '@angular/router';
import { ThemeToggleComponent } from '../../shared/components/theme-toggle/theme-toggle.component';

/**
 * Public Terms of Service page, served at `/terms`.
 *
 * Linked from the registration form's required "I agree to the Terms of
 * Service and Privacy Policy" checkbox - see
 * features/auth/components/register/register.component.html. That checkbox
 * used to point at a route that did not exist (the wildcard route redirected
 * it back to `/`), so this page and PrivacyComponent exist to make that
 * consent link resolve to something real.
 *
 * Deliberately plain, surface-level boilerplate: this is a small, largely
 * unmonetized project, not a company with legal counsel. No invented company
 * name, address, jurisdiction, or promises the product can't keep.
 */
@Component({
  selector: 'mcp-terms',
  standalone: true,
  imports: [CommonModule, RouterModule, ThemeToggleComponent],
  templateUrl: './terms.component.html',
  styleUrls: ['./legal-page.scss'],
})
export class TermsComponent {
  readonly lastUpdated = 'August 25, 2026';
}
