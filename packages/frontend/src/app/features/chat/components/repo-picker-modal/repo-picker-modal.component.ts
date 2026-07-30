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
import { Subject, debounceTime, distinctUntilChanged, switchMap, takeUntil } from 'rxjs';
import { GitHubRepoEntry, GitHubService } from '../../../../core/services/github.service';

/** Result returned when the modal closes after a repo/URL is chosen. */
export interface RepoPickerResult {
  repoUrl: string;
}

/** Matches github.com/owner/repo (with or without scheme, trailing slash, or .git). */
const GITHUB_URL_PATTERN =
  /^(?:https?:\/\/)?(?:www\.)?github\.com\/[\w.-]+\/[\w.-]+\/?(?:\.git)?\/?$/i;

function githubUrlValidator(control: { value: string }): Record<string, boolean> | null {
  const value = (control.value || '').trim();
  if (!value) return null;
  return GITHUB_URL_PATTERN.test(value) ? null : { invalidGithubUrl: true };
}

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
  githubConfigured = signal(false);

  private readonly searchSubject = new Subject<string>();
  private readonly destroy$ = new Subject<void>();

  constructor(
    private readonly fb: FormBuilder,
    private readonly githubService: GitHubService,
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
        this.githubConfigured.set(response.available);
        this.myRepos.set(response.available ? response.repos : []);
      },
      error: () => {
        this.isLoadingMyRepos.set(false);
        this.githubConfigured.set(false);
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

  submitUrl(): void {
    if (this.urlForm.invalid) return;
    const raw = (this.urlForm.get('url')?.value || '').trim();
    const withScheme = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
    this.dialogRef.close({ repoUrl: withScheme });
  }

  cancel(): void {
    this.dialogRef.close();
  }
}
