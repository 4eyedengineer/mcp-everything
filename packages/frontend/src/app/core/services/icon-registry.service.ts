import { Injectable } from '@angular/core';
import { DomSanitizer } from '@angular/platform-browser';
import { MatIconRegistry } from '@angular/material/icon';

/**
 * Registers brand SVG icons (OAuth provider marks) with Angular Material's
 * icon registry so they can be used as `<mat-icon svgIcon="...">` anywhere
 * in the app, instead of the built-in ligature icon font.
 *
 * The SVGs themselves live under `src/assets/logos/` - see that folder for
 * provenance notes (official GitHub/Google brand assets, not hotlinked).
 */
@Injectable({ providedIn: 'root' })
export class IconRegistryService {
  constructor(
    private readonly iconRegistry: MatIconRegistry,
    private readonly sanitizer: DomSanitizer
  ) {}

  /** Call once at bootstrap, mirroring ThemeService/AuthService's init() hook in app.config.ts. */
  init(): void {
    this.iconRegistry.addSvgIcon(
      'github-logo',
      this.sanitizer.bypassSecurityTrustResourceUrl('assets/logos/github-mark.svg')
    );
    this.iconRegistry.addSvgIcon(
      'google-logo',
      this.sanitizer.bypassSecurityTrustResourceUrl('assets/logos/google-logo.svg')
    );
  }
}
