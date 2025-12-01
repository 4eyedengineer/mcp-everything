import { Injectable } from '@angular/core';
import { BehaviorSubject, Observable } from 'rxjs';

export interface LoadingState {
  key: string;
  message?: string;
  progress?: number;
}

@Injectable({
  providedIn: 'root'
})
export class LoadingService {
  private loadingStates = new Map<string, LoadingState>();
  private loadingSubject = new BehaviorSubject<LoadingState[]>([]);

  /**
   * Observable of all active loading states
   */
  public loading$ = this.loadingSubject.asObservable();

  /**
   * Start loading with a unique key
   */
  start(key: string, message?: string): void {
    this.loadingStates.set(key, { key, message });
    this.emit();
  }

  /**
   * Stop loading for a specific key
   */
  stop(key: string): void {
    this.loadingStates.delete(key);
    this.emit();
  }

  /**
   * Update loading message or progress
   */
  update(key: string, message?: string, progress?: number): void {
    const existing = this.loadingStates.get(key);
    if (existing) {
      this.loadingStates.set(key, {
        ...existing,
        message: message ?? existing.message,
        progress: progress ?? existing.progress
      });
      this.emit();
    }
  }

  /**
   * Check if a specific key is loading
   */
  isLoading(key: string): boolean {
    return this.loadingStates.has(key);
  }

  /**
   * Check if any loading is active
   */
  hasAnyLoading(): boolean {
    return this.loadingStates.size > 0;
  }

  /**
   * Get specific loading state
   */
  getLoadingState(key: string): LoadingState | undefined {
    return this.loadingStates.get(key);
  }

  /**
   * Clear all loading states
   */
  clearAll(): void {
    this.loadingStates.clear();
    this.emit();
  }

  /**
   * Emit current loading states
   */
  private emit(): void {
    this.loadingSubject.next(Array.from(this.loadingStates.values()));
  }
}