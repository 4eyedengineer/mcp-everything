import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable } from 'rxjs';
import { API_V1_BASE } from '../config/api.config';

export interface UsageStatsCurrentPeriod {
  generations: number;
  limit: number;
  percentUsed: number;
  periodEnd: string;
}

export interface UsageStatsTotals {
  generations: number;
  conversations: number;
  deployments: number;
}

export interface UsageStatsMonthlyPoint {
  /** 'YYYY-MM', oldest first. */
  month: string;
  generations: number;
}

export interface UsageStatsPipeline {
  /** 0-100, or null when there are no completed pipeline runs yet. */
  successRate: number | null;
  avgDurationSeconds: number | null;
  totalRuns: number;
}

export interface UsageStatsResponse {
  currentPeriod: UsageStatsCurrentPeriod;
  totals: UsageStatsTotals;
  monthly: UsageStatsMonthlyPoint[];
  pipeline: UsageStatsPipeline;
}

/**
 * Typed client for GET /api/v1/usage-stats - the real, per-user analytics
 * that back the account page "Usage Statistics" panel.
 */
@Injectable({
  providedIn: 'root',
})
export class UsageStatsService {
  private readonly baseUrl = `${API_V1_BASE}/usage-stats`;

  constructor(private http: HttpClient) {}

  getUsageStats(): Observable<UsageStatsResponse> {
    return this.http.get<UsageStatsResponse>(this.baseUrl);
  }
}
