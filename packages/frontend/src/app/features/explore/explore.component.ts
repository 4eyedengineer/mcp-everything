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
      sortOrder: 'desc',
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

  onPageChange(event: PageEvent): void {
    this.currentPage = event.pageIndex + 1;
    this.pageSize = event.pageSize;
    this.loadServers();
  }

  viewDetails(server: ServerSummaryResponse): void {
    this.router.navigate(['/explore', server.slug]);
  }

  downloadServer(server: ServerSummaryResponse): void {
    // Record the download
    this.marketplaceService.recordDownload(server.id).subscribe({
      next: () => {
        // If there's a download URL, use it
        if ((server as any).downloadUrl) {
          window.open((server as any).downloadUrl, '_blank');
        } else {
          this.notificationService.info(`Download started for ${server.name}`);
        }

        // Update the download count locally
        const servers = this.servers$.value;
        const index = servers.findIndex((s) => s.id === server.id);
        if (index !== -1) {
          servers[index] = { ...servers[index], downloadCount: servers[index].downloadCount + 1 };
          this.servers$.next([...servers]);
        }
      },
      error: (err) => {
        console.error('Failed to record download:', err);
        this.notificationService.error('Failed to download server');
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
}
