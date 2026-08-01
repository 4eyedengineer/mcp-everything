import { Injectable } from '@angular/core';
import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { Router } from '@angular/router';
import { BehaviorSubject, Observable, throwError } from 'rxjs';
import { tap, catchError } from 'rxjs/operators';
import { API_V1_BASE } from '../config/api.config';
import { NotificationService } from './notification.service';
import { SessionService } from './session.service';

export interface User {
  id: string;
  email: string;
  firstName?: string;
  lastName?: string;
  avatarUrl?: string;
  provider?: 'local' | 'github' | 'google';
  createdAt: string;
  updatedAt: string;
}

/** Human-readable name for display, falling back to the email local part. */
export function userDisplayName(user: User): string {
  const name = [user.firstName, user.lastName].filter(Boolean).join(' ');
  return name || user.email.split('@')[0];
}

export interface RegisterRequest {
  email: string;
  password: string;
  firstName?: string;
  lastName?: string;
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
  newPassword: string;
}

const ACCESS_TOKEN_KEY = 'mcp-auth-token';
const REFRESH_TOKEN_KEY = 'mcp-refresh-token';

@Injectable({
  providedIn: 'root'
})
export class AuthService {
  private readonly apiUrl = API_V1_BASE;
  private currentUserSubject = new BehaviorSubject<User | null>(null);
  private isAuthenticatedSubject = new BehaviorSubject<boolean>(false);
  private isLoadingSubject = new BehaviorSubject<boolean>(true);

  public currentUser$ = this.currentUserSubject.asObservable();
  public isAuthenticated$ = this.isAuthenticatedSubject.asObservable();
  public isLoading$ = this.isLoadingSubject.asObservable();

  constructor(
    private http: HttpClient,
    private router: Router,
    private notificationService: NotificationService,
    private sessionService: SessionService
  ) {}

  /**
   * The backend binds a chat session id to the first user that claims it, so
   * a session id must never outlive a change of signed-in identity - reusing
   * one across accounts makes the stream-ticket endpoint reject the session
   * ("Session not found") and the chat stream silently breaks. Called on
   * login, register, OAuth callback, and logout (NOT on silent token refresh,
   * which is the same identity).
   */
  private rotateChatSession(): void {
    this.sessionService.clearSessionId();
  }

  /**
   * Restore the session from a stored token. Called from an app initializer
   * (see app.config.ts) rather than the constructor: the HTTP interceptor
   * chain injects AuthService, so issuing an HTTP request while the
   * constructor is still running creates a circular DI instantiation that
   * fails synchronously and wiped the stored tokens via logout().
   */
  init(): void {
    this.checkStoredToken();
  }

  /**
   * Register a new user with email and password
   */
  register(data: RegisterRequest): Observable<TokenResponse> {
    return this.http.post<TokenResponse>(`${this.apiUrl}/auth/register`, data).pipe(
      tap(response => {
        this.rotateChatSession();
        this.handleAuthResponse(response);
      }),
      catchError(error => this.handleError(error))
    );
  }

  /**
   * Login with email and password
   */
  login(email: string, password: string): Observable<TokenResponse> {
    return this.http.post<TokenResponse>(`${this.apiUrl}/auth/login`, { email, password }).pipe(
      tap(response => {
        this.rotateChatSession();
        this.handleAuthResponse(response);
      }),
      catchError(error => this.handleError(error))
    );
  }

  /**
   * Route prefixes that do NOT require authentication (kept in sync with
   * `app.routes.ts` - `/explore/**` has no `canActivate: [authGuard]`, and
   * `/auth/**` is inherently public/pre-login). `logout()` must not force
   * navigation away from these: a user reading the public /explore
   * marketplace (or already on an /auth page) whose background token
   * refresh happens to fail must not be yanked to the login screen.
   */
  private readonly publicRoutePrefixes = ['/explore', '/auth'];

  private isCurrentRoutePublic(): boolean {
    const url = this.router.url;
    return this.publicRoutePrefixes.some(
      prefix => url === prefix || url.startsWith(`${prefix}/`) || url.startsWith(`${prefix}?`)
    );
  }

  /**
   * Logout the current user
   */
  logout(): void {
    this.rotateChatSession();
    this.clearTokens();
    this.currentUserSubject.next(null);
    this.isAuthenticatedSubject.next(false);
    // Only redirect if the user is actually somewhere that requires auth -
    // don't hijack a public page just because a session teardown happened.
    if (!this.isCurrentRoutePublic()) {
      this.router.navigate(['/auth/login']);
    }
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
        this.notifySessionExpired();
        this.logout();
        return throwError(() => error);
      })
    );
  }

  /**
   * Inform the user that their session could not be restored/renewed - this
   * is the single place a real, non-recoverable 401 (one that survives the
   * silent refresh attempt in the auth interceptor / checkStoredToken)
   * results in a toast, so it never fires speculatively during the normal
   * boot/refresh race.
   *
   * Shown as sticky (persistent, requires dismissal) only when it happens
   * mid-session - i.e. the user was actively using the app and got signed
   * out unexpectedly, the "truly warranted" case for a persistent toast. A
   * failed silent restore at boot (the user hasn't done anything yet this
   * session) gets a normal auto-dismissing toast.
   */
  private notifySessionExpired(): void {
    const isBootRestore = this.isLoadingSubject.value;
    this.notificationService.error(
      'Session Expired',
      'Please sign in again to continue.',
      undefined,
      { persistent: !isBootRestore }
    );
  }

  /**
   * Get the current user's profile
   */
  getProfile(): Observable<User> {
    return this.http.get<User>(`${this.apiUrl}/auth/me`).pipe(
      tap(user => {
        this.currentUserSubject.next(user);
        this.isAuthenticatedSubject.next(true);
      }),
      catchError(error => this.handleError(error))
    );
  }

  /**
   * Handle OAuth callback - store tokens and fetch user profile
   */
  handleOAuthCallback(token: string, refreshToken: string): Observable<User> {
    this.rotateChatSession();
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
    // Backend ResetPasswordDto requires `newPassword` and whitelist-rejects
    // any other body keys (e.g. a plain `password`) - it must match exactly.
    return this.http.post<{ message: string }>(`${this.apiUrl}/auth/reset-password`, { token, newPassword: password }).pipe(
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
   * Whether the initial session restore (from a stored token, run at app
   * boot via `init()`) is still in flight. Used by the error interceptor to
   * avoid toasting on 401s that are an expected, transient part of that
   * restore rather than a real auth failure.
   */
  get isLoading(): boolean {
    return this.isLoadingSubject.value;
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
  getRefreshToken(): string | null {
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
