import { Component, OnDestroy, OnInit, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormBuilder, FormGroup, ReactiveFormsModule, Validators } from '@angular/forms';
import { MatDialogModule, MatDialogRef } from '@angular/material/dialog';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatTabsModule } from '@angular/material/tabs';
import { MatSnackBar, MatSnackBarModule } from '@angular/material/snack-bar';
import { Subject, debounceTime, distinctUntilChanged, switchMap, takeUntil } from 'rxjs';
import {
  GitHubRepoEntry,
  GitHubRepoSource,
  GitHubService,
} from '../../../../core/services/github.service';
import { AuthService } from '../../../../core/services/auth.service';

/** Result returned when the modal closes after a repo/URL is chosen. */
export interface RepoPickerResult {
  repoUrl: string;
}

/**
 * Matches a GitHub repo reference in either form:
 *  - full URL: (https://)(www.)github.com/owner/repo(.git)(/)
 *  - short form: owner/repo
 * The `github.com/` prefix (and scheme) is entirely optional so the short
 * form validates too - the placeholder text invites pasting either.
 */
const GITHUB_URL_PATTERN =
  /^(?:(?:https?:\/\/)?(?:www\.)?github\.com\/)?[\w.-]+\/[\w.-]+\/?(?:\.git)?\/?$/i;

function githubUrlValidator(control: { value: string }): Record<string, boolean> | null {
  const value = (control.value || '').trim();
  if (!value) return null;
  return GITHUB_URL_PATTERN.test(value) ? null : { invalidGithubUrl: true };
}

/** Strip a trailing `.git`/slash and pull `{owner, repo}` out of either input form. */
function extractOwnerRepo(raw: string): { owner: string; repo: string } | null {
  const trimmed = raw
    .trim()
    .replace(/\.git$/i, '')
    .replace(/\/+$/, '');
  const match = trimmed.match(/^(?:https?:\/\/)?(?:www\.)?(?:github\.com\/)?([\w.-]+)\/([\w.-]+)$/i);
  return match ? { owner: match[1], repo: match[2] } : null;
}

/** Normalize either input form to a full `https://github.com/owner/repo` URL. */
function normalizeGithubUrl(raw: string): string {
  const parsed = extractOwnerRepo(raw);
  if (parsed) {
    return `https://github.com/${parsed.owner}/${parsed.repo}`;
  }
  // Shouldn't happen given the validator, but fail open with a best-effort URL.
  const trimmed = raw.trim();
  return /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
}

/**
 * The four honest states the "your repositories" section can be in - see
 * GitHubReposResponse.connected/source/reason (backend) for how each is
 * derived. Deliberately NOT a single "githubConfigured" boolean (that
 * collapsed all of these into one, which is what made the old copy - "connect
 * a GitHub account to enable this" - untrue for a user who HAD connected one).
 */
export type GithubRepoPanelState =
  /** No stored token for this user - "Connect GitHub" is the fix. */
  | 'not_connected'
  /** Stored token exists, but GitHub rejected it (or it can't be decrypted) - "Reconnect" is the fix. */
  | 'needs_reconnect'
  /** No usable personal token; showing the server-configured account's repos instead. */
  | 'server_fallback'
  /** Personal token present and working. */
  | 'connected';

@Component({
  selector: 'mcp-repo-picker-modal',
  standalone: true,
  imports: [
    CommonModule,
    ReactiveFormsModule,
    MatDialogModule,
    MatFormFieldModule,
    MatInputModule,
    MatButtonModule,
    MatIconModule,
    MatProgressSpinnerModule,
    MatTabsModule,
    MatSnackBarModule,
  ],
  templateUrl: './repo-picker-modal.component.html',
  styleUrls: ['./repo-picker-modal.component.scss'],
})
export class RepoPickerModalComponent implements OnInit, OnDestroy {
  urlForm: FormGroup;

  searchQuery = signal('');
  searchResults = signal<GitHubRepoEntry[]>([]);
  isSearching = signal(false);
  hasSearched = signal(false);
  searchError = signal<string | null>(null);

  myRepos = signal<GitHubRepoEntry[]>([]);
  isLoadingMyRepos = signal(false);
  githubPanelState = signal<GithubRepoPanelState>('not_connected');

  // Repo-existence pre-flight for a hand-typed URL (see submitUrl()) - stops
  // a typo'd or dead repo from silently kicking off a paid generation run.
  isCheckingUrl = signal(false);
  urlCheckError = signal<string | null>(null);

  private readonly searchSubject = new Subject<string>();
  private readonly destroy$ = new Subject<void>();

  constructor(
    private readonly fb: FormBuilder,
    private readonly githubService: GitHubService,
    private readonly authService: AuthService,
    private readonly snackBar: MatSnackBar,
    private readonly dialogRef: MatDialogRef<RepoPickerModalComponent, RepoPickerResult>,
  ) {
    this.urlForm = this.fb.group({
      url: ['', [Validators.required, githubUrlValidator]],
    });
  }

  ngOnInit(): void {
    this.searchSubject
      .pipe(
        debounceTime(350),
        distinctUntilChanged(),
        switchMap((query) => {
          if (!query.trim()) {
            this.isSearching.set(false);
            return [];
          }
          this.isSearching.set(true);
          this.searchError.set(null);
          return this.githubService.searchPublicRepos(query.trim());
        }),
        takeUntil(this.destroy$),
      )
      .subscribe({
        next: (response) => {
          this.isSearching.set(false);
          this.hasSearched.set(true);
          if (response.available) {
            this.searchResults.set(response.repos);
          } else {
            this.searchResults.set([]);
            this.searchError.set(
              response.reason === 'rate_limited'
                ? 'GitHub search is rate-limited right now. Try again shortly, or paste a repo URL directly.'
                : 'GitHub search is unavailable right now. Try pasting a repo URL directly.',
            );
          }
        },
        error: () => {
          this.isSearching.set(false);
          this.hasSearched.set(true);
          this.searchResults.set([]);
          this.searchError.set('GitHub search is unavailable right now. Try pasting a repo URL directly.');
        },
      });

    // Clear a stale "doesn't exist" error the moment the user edits the URL,
    // so it can't linger and look like it applies to their new input.
    this.urlForm.get('url')?.valueChanges.pipe(takeUntil(this.destroy$)).subscribe(() => {
      this.urlCheckError.set(null);
    });

    this.loadMyRepos();
  }

  ngOnDestroy(): void {
    this.destroy$.next();
    this.destroy$.complete();
  }

  private loadMyRepos(): void {
    this.isLoadingMyRepos.set(true);
    this.githubService.listMyRepos().subscribe({
      next: (response) => {
        this.isLoadingMyRepos.set(false);
        this.githubPanelState.set(
          derivePanelState(response.connected ?? false, response.available, response.source),
        );
        this.myRepos.set(response.available ? response.repos : []);
      },
      error: () => {
        this.isLoadingMyRepos.set(false);
        this.githubPanelState.set('not_connected');
        this.myRepos.set([]);
      },
    });
  }

  onSearchInput(event: Event): void {
    const value = (event.target as HTMLInputElement).value;
    this.searchQuery.set(value);
    this.searchSubject.next(value);
  }

  selectRepo(repo: GitHubRepoEntry): void {
    this.dialogRef.close({ repoUrl: repo.url });
  }

  /**
   * Starts the standard GitHub OAuth flow (same one used for login/register).
   * Note: this is a full-page redirect through GitHub and back to
   * `/auth/callback`, which signs the browser in as whichever app account
   * that GitHub identity resolves to (by githubId, then by matching email -
   * see AuthService#validateOAuthUser on the backend). If the user is
   * currently logged in under a different email than their GitHub account,
   * this can switch which account is signed in rather than "adding" GitHub
   * to the current one - this is pre-existing behavior of the shared OAuth
   * callback, not something specific to connecting from this modal.
   */
  connectGithub(): void {
    window.location.href = this.authService.getGitHubLoginUrl();
  }

  submitUrl(): void {
    if (this.urlForm.invalid || this.isCheckingUrl()) return;

    const raw = (this.urlForm.get('url')?.value || '').trim();
    const parsed = extractOwnerRepo(raw);
    const repoUrl = normalizeGithubUrl(raw);

    if (!parsed) {
      // Validator already guarantees this shape; fail open rather than block.
      this.dialogRef.close({ repoUrl });
      return;
    }

    this.isCheckingUrl.set(true);
    this.urlCheckError.set(null);

    this.githubService.checkRepoExists(parsed.owner, parsed.repo).subscribe({
      next: (result) => {
        this.isCheckingUrl.set(false);

        if (result.status === 'not_found') {
          this.urlCheckError.set(
            `Couldn't find ${parsed.owner}/${parsed.repo} on GitHub - check the URL, or it may be private.`,
          );
          return;
        }

        if (result.status === 'unknown') {
          // Inconclusive (rate-limited/network error) - a false "missing" is
          // worse than an unchecked send, so warn and proceed rather than
          // blocking the user.
          this.snackBar.open(
            "Couldn't verify this repository right now - continuing anyway.",
            'Dismiss',
            { duration: 4000 },
          );
        }

        this.dialogRef.close({ repoUrl });
      },
      error: () => {
        this.isCheckingUrl.set(false);
        this.snackBar.open(
          "Couldn't verify this repository right now - continuing anyway.",
          'Dismiss',
          { duration: 4000 },
        );
        this.dialogRef.close({ repoUrl });
      },
    });
  }

  cancel(): void {
    this.dialogRef.close();
  }
}

function derivePanelState(
  connected: boolean,
  available: boolean,
  source: GitHubRepoSource | undefined,
): GithubRepoPanelState {
  if (!connected) {
    return available && source === 'server' ? 'server_fallback' : 'not_connected';
  }
  // connected === true from here down: either the personal token is working
  // (source === 'user'), or it isn't (rejected by GitHub - reason ===
  // 'user_token_invalid' - or undecryptable, which falls back to source ===
  // 'server') - either failure case has the same fix: reconnect.
  return available && source === 'user' ? 'connected' : 'needs_reconnect';
}
