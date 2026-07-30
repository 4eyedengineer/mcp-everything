import { Component, OnInit, computed, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { MatIconModule } from '@angular/material/icon';
import {
  UsageStatsResponse,
  UsageStatsService,
} from '../../../../core/services/usage-stats.service';
import { parseHttpError } from '../../../../shared/utils/http-error.util';
import { HttpErrorResponse } from '@angular/common/http';

/**
 * Self-contained "Usage Statistics" panel for the account page.
 *
 * Fetches GET /api/v1/usage-stats and renders it: current-period quota vs
 * limit (progress bar), lifetime totals, a 6-month generation trend (pure
 * CSS bars, no chart library), and pipeline health when there is any
 * completed run to report on. Handles its own loading/error/empty states so
 * it can be dropped into account.component.html as a single element.
 */
@Component({
  selector: 'mcp-usage-stats-section',
  standalone: true,
  imports: [CommonModule, MatIconModule],
  templateUrl: './usage-stats-section.component.html',
  styleUrls: ['./usage-stats-section.component.scss'],
})
export class UsageStatsSectionComponent implements OnInit {
  readonly loading = signal(true);
  readonly error = signal<string | null>(null);
  readonly stats = signal<UsageStatsResponse | null>(null);

  /** 999999 is the platform's "unlimited" sentinel (see SubscriptionService). */
  readonly isUnlimited = computed(() => (this.stats()?.currentPeriod?.limit ?? 0) >= 999999);

  readonly percentUsedClamped = computed(() => {
    const s = this.stats();
    if (!s || this.isUnlimited()) return 0;
    return Math.min(100, Math.max(0, s.currentPeriod.percentUsed));
  });

  readonly isNearLimit = computed(() => !this.isUnlimited() && this.percentUsedClamped() >= 80);
  readonly isAtLimit = computed(() => !this.isUnlimited() && this.percentUsedClamped() >= 100);

  readonly hasAnyActivity = computed(() => {
    const t = this.stats()?.totals;
    return !!t && (t.generations > 0 || t.conversations > 0 || t.deployments > 0);
  });

  /** Tallest bar in the monthly trend, floored at 1 so an all-zero trend still renders flat empty bars instead of dividing by zero. */
  readonly monthlyMax = computed(() => {
    const monthly = this.stats()?.monthly ?? [];
    return Math.max(1, ...monthly.map((m) => m.generations));
  });

  readonly hasPipelineData = computed(() => (this.stats()?.pipeline?.totalRuns ?? 0) > 0);

  constructor(private readonly usageStatsService: UsageStatsService) {}

  ngOnInit(): void {
    this.load();
  }

  load(): void {
    this.loading.set(true);
    this.error.set(null);
    this.usageStatsService.getUsageStats().subscribe({
      next: (stats) => {
        this.stats.set(stats);
        this.loading.set(false);
      },
      error: (err: HttpErrorResponse) => {
        this.error.set(parseHttpError(err, 'Unable to load usage statistics.'));
        this.loading.set(false);
      },
    });
  }

  monthLabel(month: string): string {
    const [year, monthNum] = month.split('-').map(Number);
    const date = new Date(year, (monthNum || 1) - 1, 1);
    return date.toLocaleDateString(undefined, { month: 'short' });
  }

  barHeightPercent(generations: number): number {
    const max = this.monthlyMax();
    if (max <= 0) return 0;
    // Floor so a real-but-small value (e.g. 1 generation among a max of 50)
    // is still visibly a bar, not an invisible sliver.
    return Math.max(generations > 0 ? 6 : 0, Math.round((generations / max) * 100));
  }
}
