import { Injectable, signal, effect } from '@angular/core';

export type ThemeMode = 'light' | 'dark' | 'system';

const STORAGE_KEY = 'theme';
const DARK_CLASS = 'dark-theme';

/**
 * Signal-based theme service.
 *
 * - `mode` is the user's preference: 'light' | 'dark' | 'system'.
 * - `isDark` reflects the *effective* resolved theme (accounting for the
 *   OS-level `prefers-color-scheme` when mode is 'system').
 * - The resolved theme is applied by toggling the `.dark-theme` class on
 *   `document.documentElement`, so both the app root and any Material
 *   CDK overlays (dialogs, snackbars, menus - which are appended to
 *   `document.body`, a descendant of `documentElement`) pick up the
 *   dark palette and dark Material component theme.
 */
@Injectable({ providedIn: 'root' })
export class ThemeService {
  private readonly media = typeof window !== 'undefined' && 'matchMedia' in window
    ? window.matchMedia('(prefers-color-scheme: dark)')
    : null;

  /** User's stored preference. */
  readonly mode = signal<ThemeMode>(this.readStoredMode());

  /** Live tracking of the OS-level color scheme (only relevant for 'system'). */
  private readonly systemPrefersDark = signal(this.media?.matches ?? false);

  /** The effective, resolved dark/light state actually applied to the DOM. */
  readonly isDark = signal(this.computeIsDark(this.mode(), this.systemPrefersDark()));

  constructor() {
    this.media?.addEventListener('change', (e) => this.systemPrefersDark.set(e.matches));

    // Keep isDark in sync whenever mode or the OS preference changes, and
    // apply/persist as a side effect.
    effect(() => {
      const dark = this.computeIsDark(this.mode(), this.systemPrefersDark());
      this.isDark.set(dark);
      this.applyClass(dark);
    });

    effect(() => {
      this.persist(this.mode());
    });
  }

  /** Call once at bootstrap so the correct theme is applied before first paint as much as possible. */
  init(): void {
    // Reading the signals above already runs the effects synchronously on
    // construction, but injecting the service is what triggers it - so this
    // method mainly exists to give app.config.ts an explicit, readable hook.
    this.applyClass(this.isDark());
  }

  setMode(mode: ThemeMode): void {
    this.mode.set(mode);
  }

  private computeIsDark(mode: ThemeMode, systemPrefersDark: boolean): boolean {
    if (mode === 'dark') return true;
    if (mode === 'light') return false;
    return systemPrefersDark;
  }

  private applyClass(dark: boolean): void {
    if (typeof document === 'undefined') return;
    document.documentElement.classList.toggle(DARK_CLASS, dark);
  }

  private persist(mode: ThemeMode): void {
    try {
      localStorage.setItem(STORAGE_KEY, mode);
    } catch {
      // localStorage may be unavailable (SSR, privacy mode) - ignore.
    }
  }

  private readStoredMode(): ThemeMode {
    try {
      const stored = localStorage.getItem(STORAGE_KEY);
      if (stored === 'light' || stored === 'dark' || stored === 'system') {
        return stored;
      }
    } catch {
      // ignore
    }
    return 'system';
  }
}
