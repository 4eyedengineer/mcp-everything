import { Component, OnInit, OnDestroy } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Router, RouterModule } from '@angular/router';
import { MatIconModule } from '@angular/material/icon';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatSelectModule } from '@angular/material/select';
import { MatPaginatorModule, PageEvent } from '@angular/material/paginator';
import { BehaviorSubject, Subject, debounceTime, distinctUntilChanged, takeUntil } from 'rxjs';
import {
  MarketplaceService,
  ServerSummaryResponse,
  CategoryResponse,
  SearchParams,
  McpServerCategory,
  SortField,
  SortOrder,
} from '../../core/services/marketplace.service';
import { ServerCardComponent } from '../../shared/components/server-card/server-card.component';
import { NotificationService } from '../../core/services/notification.service';

@Component({
  selector: 'mcp-explore',
  standalone: true,
  imports: [
    CommonModule,
    FormsModule,
    RouterModule,
    MatIconModule,
    MatProgressSpinnerModule,
    MatFormFieldModule,
    MatInputModule,
    MatSelectModule,
    MatPaginatorModule,
    ServerCardComponent,
  ],
  templateUrl: './explore.component.html',
  styleUrls: ['./explore.component.scss'],
})
export class ExploreComponent implements OnInit, OnDestroy {
  // State
  servers$ = new BehaviorSubject<ServerSummaryResponse[]>([]);
  featuredServers$ = new BehaviorSubject<ServerSummaryResponse[]>([]);
  categories$ = new BehaviorSubject<CategoryResponse[]>([]);

  // UI State
  isLoading = false;
  isLoadingFeatured = false;
  error: string | null = null;

  // Search & Filter State
  searchQuery = '';
  selectedCategory = '';
  selectedSort: SortField = 'downloads';

  // Pagination State
  currentPage = 1;
  pageSize = 20;
  totalItems = 0;
  totalPages = 0;

  // Search debounce
  private searchSubject = new Subject<string>();
  private destroy$ = new Subject<void>();

  // Fields that should sort ascending by default (e.g. "Name (A-Z)"). Every
  // other field (downloads, rating, recency) reads most-relevant-first, i.e.
  // descending. Without this, every sort field - including name - was forced
  // to 'desc', so "Name (A-Z)" actually rendered Z->A.
  private static readonly ASCENDING_SORT_FIELDS: ReadonlySet<SortField> = new Set<SortField>([
    'name',
  ]);

  constructor(
    private marketplaceService: MarketplaceService,
    private notificationService: NotificationService,
    private router: Router
  ) {}

  ngOnInit(): void {
    // Setup search debounce
    this.searchSubject
      .pipe(debounceTime(300), distinctUntilChanged(), takeUntil(this.destroy$))
      .subscribe((query) => {
        this.searchQuery = query;
        this.currentPage = 1;
        this.loadServers();
      });

    // Initial data load
    this.loadCategories();
    this.loadFeaturedServers();
    this.loadServers();
  }

  ngOnDestroy(): void {
    this.destroy$.next();
    this.destroy$.complete();
  }

  loadFeaturedServers(): void {
    this.isLoadingFeatured = true;
    this.marketplaceService.getFeatured(6).subscribe({
      next: (servers) => {
        this.featuredServers$.next(servers);
        this.isLoadingFeatured = false;
      },
      error: (err) => {
        console.error('Failed to load featured servers:', err);
        this.isLoadingFeatured = false;
      },
    });
  }

  loadCategories(): void {
    this.marketplaceService.getCategories().subscribe({
      next: (categories) => {
        this.categories$.next(categories);
      },
      error: (err) => {
        console.error('Failed to load categories:', err);
      },
    });
  }

  loadServers(): void {
    this.isLoading = true;
    this.error = null;

    const params: SearchParams = {
      page: this.currentPage,
      limit: this.pageSize,
      sortBy: this.selectedSort,
      sortOrder: this.sortOrderFor(this.selectedSort),
    };

    if (this.searchQuery) {
      params.query = this.searchQuery;
    }

    if (this.selectedCategory) {
      params.category = this.selectedCategory as McpServerCategory;
    }

    this.marketplaceService.search(params).subscribe({
      next: (response) => {
        this.servers$.next(response.items);
        this.totalItems = response.total;
        this.totalPages = response.totalPages;
        this.isLoading = false;
      },
      error: (err) => {
        console.error('Failed to load servers:', err);
        this.error = 'Failed to load servers. Please try again.';
        this.isLoading = false;
      },
    });
  }

  onSearchChange(event: Event): void {
    const target = event.target as HTMLInputElement;
    this.searchSubject.next(target.value);
  }

  onCategoryChange(): void {
    this.currentPage = 1;
    this.loadServers();
  }

  onSortChange(): void {
    this.currentPage = 1;
    this.loadServers();
  }

  /** Name sorts A-Z (ascending); every other field is most-relevant-first (descending). */
  private sortOrderFor(field: SortField): SortOrder {
    return ExploreComponent.ASCENDING_SORT_FIELDS.has(field) ? 'asc' : 'desc';
  }

  onPageChange(event: PageEvent): void {
    this.currentPage = event.pageIndex + 1;
    this.pageSize = event.pageSize;
    this.loadServers();
  }

  viewDetails(server: ServerSummaryResponse): void {
    this.router.navigate(['/explore', server.slug]);
  }

  /**
   * These marketplace entries are source-only (real GitHub repos, no
   * downloadable artifact), so this opens the real source instead of
   * pretending a download happened. `mcp-server-card` only renders the
   * action button when `sourceUrlFor()` returns something, so the
   * `!sourceUrl` branch below is a defensive fallback, not the common case.
   */
  downloadServer(server: ServerSummaryResponse): void {
    const sourceUrl = server.repositoryUrl || server.gistUrl;
    if (!sourceUrl) {
      this.notificationService.info(`No public source is available yet for ${server.name}.`);
      return;
    }

    // Record the click-through, then open the real source.
    this.marketplaceService.recordDownload(server.id).subscribe({
      next: () => {
        window.open(sourceUrl, '_blank', 'noopener');

        // Update the download count locally
        const servers = this.servers$.value;
        const index = servers.findIndex((s) => s.id === server.id);
        if (index !== -1) {
          servers[index] = { ...servers[index], downloadCount: servers[index].downloadCount + 1 };
          this.servers$.next([...servers]);
        }
      },
      error: (err) => {
        // The global error interceptor already shows a toast for the failed
        // request - avoid showing a second, redundant one here. The user
        // should still be able to reach the real source even if recording
        // the click-through failed.
        console.error('Failed to record download:', err);
        window.open(sourceUrl, '_blank', 'noopener');
      },
    });
  }

  clearFilters(): void {
    this.searchQuery = '';
    this.selectedCategory = '';
    this.selectedSort = 'downloads';
    this.currentPage = 1;
    this.loadServers();
  }

  get hasFilters(): boolean {
    return !!this.searchQuery || !!this.selectedCategory || this.selectedSort !== 'downloads';
  }

  /**
   * The Featured section is a curated view of the *unfiltered* catalog. Once
   * a search or category filter is active, showing it verbatim alongside a
   * filtered (or empty) main grid makes non-matching featured servers look
   * like they matched the filter - so hide it whenever either is active.
   * (Sort order doesn't affect this - only search/category narrow results.)
   */
  get showFeatured(): boolean {
    return !this.searchQuery && !this.selectedCategory;
  }
}
