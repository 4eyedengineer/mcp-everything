import {
  HttpErrorResponse,
  HttpEvent,
  HttpHandlerFn,
  HttpInterceptorFn,
  HttpRequest
} from '@angular/common/http';
import { inject } from '@angular/core';
import { BehaviorSubject, Observable, throwError } from 'rxjs';
import { catchError, filter, finalize, switchMap, take } from 'rxjs/operators';
import { AuthService } from '../services/auth.service';

// Module-level state: shared for the lifetime of the app, mirroring the
// singleton behavior the old class-based `AuthInterceptor` had via DI.
let isRefreshing = false;
const refreshTokenSubject = new BehaviorSubject<string | null>(null);

const AUTH_ENDPOINTS = [
  '/auth/login',
  '/auth/register',
  '/auth/refresh',
  '/auth/forgot-password',
  '/auth/reset-password',
  '/auth/github',
  '/auth/google',
  '/auth/me'
];

function isAuthEndpoint(url: string): boolean {
  return AUTH_ENDPOINTS.some(endpoint => url.includes(endpoint));
}

function isProtectedAuthEndpoint(url: string): boolean {
  return url.includes('/auth/me');
}

function addAuthHeader(request: HttpRequest<unknown>, token: string): HttpRequest<unknown> {
  return request.clone({
    setHeaders: {
      Authorization: `Bearer ${token}`
    }
  });
}

function handle401Error(
  request: HttpRequest<unknown>,
  authService: AuthService,
  next: HttpHandlerFn
): Observable<HttpEvent<unknown>> {
  if (!isRefreshing) {
    isRefreshing = true;
    refreshTokenSubject.next(null);

    return authService.refreshToken().pipe(
      switchMap(response => {
        refreshTokenSubject.next(response.accessToken);
        return next(addAuthHeader(request, response.accessToken));
      }),
      catchError(error => {
        // Refresh failed - logout and redirect to login
        authService.logout();
        return throwError(() => error);
      }),
      finalize(() => {
        isRefreshing = false;
      })
    );
  }

  // Token refresh is already in progress - wait for it to complete
  return refreshTokenSubject.pipe(
    filter((token): token is string => token !== null),
    take(1),
    switchMap(token => next(addAuthHeader(request, token)))
  );
}

/**
 * Attaches the bearer access token to outgoing requests (except public auth
 * endpoints), and transparently retries the request with a refreshed token on
 * a 401 response.
 */
export const authInterceptor: HttpInterceptorFn = (req, next) => {
  const authService = inject(AuthService);

  // Skip auth header for auth endpoints (except /auth/me and /auth/refresh)
  if (isAuthEndpoint(req.url) && !isProtectedAuthEndpoint(req.url)) {
    return next(req);
  }

  // Add auth header if token exists
  const token = authService.getAccessToken();
  const authedReq = token ? addAuthHeader(req, token) : req;

  return next(authedReq).pipe(
    catchError((error: HttpErrorResponse) => {
      // Handle 401 errors by attempting to refresh the token
      if (error.status === 401 && !isAuthEndpoint(req.url)) {
        return handle401Error(authedReq, authService, next);
      }
      return throwError(() => error);
    })
  );
};
