import { Injectable } from '@angular/core';
import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { Router } from '@angular/router';
import { BehaviorSubject, Observable, throwError } from 'rxjs';
import { tap, catchError } from 'rxjs/operators';
import { environment } from '../../../environments/environment';
import { StateManagementService } from './state-management.service';

export interface User {
  id: string;
  email: string;
  name: string;
  avatarUrl?: string;
  provider?: 'local' | 'github' | 'google';
  createdAt: string;
  updatedAt: string;
}

export interface RegisterRequest {
  email: string;
  password: string;
  name: string;
}

export interface LoginRequest {
  email: string;
  password: string;
}

export interface TokenResponse {
  accessToken: string;
  refreshToken: string;
  user: User;
  expiresIn: number;
}

export interface ForgotPasswordRequest {
  email: string;
}

export interface ResetPasswordRequest {
  token: string;
  password: string;
}

const ACCESS_TOKEN_KEY = 'mcp-auth-token';
const REFRESH_TOKEN_KEY = 'mcp-refresh-token';

@Injectable({
  providedIn: 'root'
})
export class AuthService {
  private readonly apiUrl = environment.apiUrl;
  private currentUserSubject = new BehaviorSubject<User | null>(null);
  private isAuthenticatedSubject = new BehaviorSubject<boolean>(false);
  private isLoadingSubject = new BehaviorSubject<boolean>(true);

  public currentUser$ = this.currentUserSubject.asObservable();
  public isAuthenticated$ = this.isAuthenticatedSubject.asObservable();
  public isLoading$ = this.isLoadingSubject.asObservable();

  constructor(
    private http: HttpClient,
    private router: Router,
    private stateService: StateManagementService
  ) {
    this.checkStoredToken();
  }

  /**
   * Register a new user with email and password
   */
  register(data: RegisterRequest): Observable<TokenResponse> {
    return this.http.post<TokenResponse>(`${this.apiUrl}/auth/register`, data).pipe(
      tap(response => this.handleAuthResponse(response)),
      catchError(error => this.handleError(error))
    );
  }

  /**
   * Login with email and password
   */
  login(email: string, password: string): Observable<TokenResponse> {
    return this.http.post<TokenResponse>(`${this.apiUrl}/auth/login`, { email, password }).pipe(
      tap(response => this.handleAuthResponse(response)),
      catchError(error => this.handleError(error))
    );
  }

  /**
   * Logout the current user
   */
  logout(): void {
    this.clearTokens();
    this.currentUserSubject.next(null);
    this.isAuthenticatedSubject.next(false);
    this.stateService.setAuthenticated(false, null);
    this.router.navigate(['/auth/login']);
  }

  /**
   * Refresh the access token using the refresh token
   */
  refreshToken(): Observable<TokenResponse> {
    const refreshToken = this.getRefreshToken();
    if (!refreshToken) {
      return throwError(() => new Error('No refresh token available'));
    }

    return this.http.post<TokenResponse>(`${this.apiUrl}/auth/refresh`, { refreshToken }).pipe(
      tap(response => this.handleAuthResponse(response)),
      catchError(error => {
        this.logout();
        return throwError(() => error);
      })
    );
  }

  /**
   * Get the current user's profile
   */
  getProfile(): Observable<User> {
    return this.http.get<User>(`${this.apiUrl}/auth/me`).pipe(
      tap(user => {
        this.currentUserSubject.next(user);
        this.stateService.setAuthenticated(true, user);
      }),
      catchError(error => this.handleError(error))
    );
  }

  /**
   * Handle OAuth callback - store tokens and fetch user profile
   */
  handleOAuthCallback(token: string, refreshToken: string): Observable<User> {
    this.setTokens(token, refreshToken);
    this.isAuthenticatedSubject.next(true);

    return this.getProfile().pipe(
      tap(() => {
        this.router.navigate(['/chat']);
      })
    );
  }

  /**
   * Request password reset email
   */
  forgotPassword(email: string): Observable<{ message: string }> {
    return this.http.post<{ message: string }>(`${this.apiUrl}/auth/forgot-password`, { email }).pipe(
      catchError(error => this.handleError(error))
    );
  }

  /**
   * Reset password using token from email
   */
  resetPassword(token: string, password: string): Observable<{ message: string }> {
    return this.http.post<{ message: string }>(`${this.apiUrl}/auth/reset-password`, { token, password }).pipe(
      catchError(error => this.handleError(error))
    );
  }

  /**
   * Check if there's a valid stored token and fetch the user profile
   */
  private checkStoredToken(): void {
    const token = this.getAccessToken();
    if (token) {
      this.isAuthenticatedSubject.next(true);
      this.getProfile().subscribe({
        next: () => {
          this.isLoadingSubject.next(false);
        },
        error: () => {
          // Token is invalid - try to refresh
          this.refreshToken().subscribe({
            next: () => {
              this.getProfile().subscribe({
                next: () => this.isLoadingSubject.next(false),
                error: () => {
                  this.logout();
                  this.isLoadingSubject.next(false);
                }
              });
            },
            error: () => {
              this.logout();
              this.isLoadingSubject.next(false);
            }
          });
        }
      });
    } else {
      this.isLoadingSubject.next(false);
    }
  }

  /**
   * Handle successful authentication response
   */
  private handleAuthResponse(response: TokenResponse): void {
    this.setTokens(response.accessToken, response.refreshToken);
    this.currentUserSubject.next(response.user);
    this.isAuthenticatedSubject.next(true);
    this.stateService.setAuthenticated(true, response.user);
  }

  /**
   * Handle HTTP errors
   */
  private handleError(error: HttpErrorResponse): Observable<never> {
    let errorMessage = 'An unexpected error occurred';

    if (error.error instanceof ErrorEvent) {
      // Client-side error
      errorMessage = error.error.message;
    } else {
      // Server-side error
      errorMessage = error.error?.message || `Error: ${error.status}`;
    }

    return throwError(() => new Error(errorMessage));
  }

  /**
   * Get the current user synchronously
   */
  get currentUser(): User | null {
    return this.currentUserSubject.value;
  }

  /**
   * Check if user is authenticated synchronously
   */
  get isAuthenticated(): boolean {
    return this.isAuthenticatedSubject.value;
  }

  /**
   * Get access token from storage
   */
  getAccessToken(): string | null {
    try {
      return localStorage.getItem(ACCESS_TOKEN_KEY);
    } catch {
      return null;
    }
  }

  /**
   * Get refresh token from storage
   */
  private getRefreshToken(): string | null {
    try {
      return localStorage.getItem(REFRESH_TOKEN_KEY);
    } catch {
      return null;
    }
  }

  /**
   * Store tokens in localStorage
   */
  private setTokens(accessToken: string, refreshToken: string): void {
    try {
      localStorage.setItem(ACCESS_TOKEN_KEY, accessToken);
      localStorage.setItem(REFRESH_TOKEN_KEY, refreshToken);
    } catch (error) {
      console.warn('Failed to store auth tokens:', error);
    }
  }

  /**
   * Clear tokens from localStorage
   */
  private clearTokens(): void {
    try {
      localStorage.removeItem(ACCESS_TOKEN_KEY);
      localStorage.removeItem(REFRESH_TOKEN_KEY);
    } catch (error) {
      console.warn('Failed to clear auth tokens:', error);
    }
  }

  /**
   * Get OAuth login URL for GitHub
   */
  getGitHubLoginUrl(): string {
    return `${this.apiUrl}/auth/github`;
  }

  /**
   * Get OAuth login URL for Google
   */
  getGoogleLoginUrl(): string {
    return `${this.apiUrl}/auth/google`;
  }
}
