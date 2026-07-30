import { HttpErrorResponse, HttpInterceptorFn, HttpRequest } from '@angular/common/http';
import { inject } from '@angular/core';
import { Router } from '@angular/router';
import { catchError, retry, throwError } from 'rxjs';
import { environment } from '../../../environments/environment';
import { NotificationService } from '../services/notification.service';
import { AuthService } from '../services/auth.service';
import { parseHttpError } from '../../shared/utils/http-error.util';

// Endpoints the auth interceptor never transparently retries on 401 (see
// AUTH_ENDPOINTS in auth.interceptor.ts) - a 401 from one of these is a
// direct, final answer (e.g. wrong password at login) rather than a token
// that's about to be silently refreshed, so it's always safe to toast.
const NON_RETRIED_AUTH_ENDPOINTS = [
  '/auth/login',
  '/auth/register',
  '/auth/refresh',
  '/auth/forgot-password',
  '/auth/reset-password',
  '/auth/github',
  '/auth/google',
  '/auth/me'
];

function shouldRetry(req: HttpRequest<unknown>): boolean {
  // Only retry GET requests
  return req.method === 'GET' && !req.url.includes('/stream');
}

function shouldSkipNotification(req: HttpRequest<unknown>): boolean {
  // Skip notifications for these endpoints
  const skipPaths = ['/health', '/status', '/auth/validate'];

  return (
    skipPaths.some(path => req.url.includes(path)) || req.headers.has('X-Skip-Error-Notification')
  );
}

/**
 * Whether a 401 on this request is about to be handled silently elsewhere,
 * and so should NOT surface a toast here:
 *
 * - While the initial session restore is still in flight (AuthService.init()
 *   -> checkStoredToken()), a 401 on /auth/me is an expected step of that
 *   restore (it triggers an internal refresh) - not a user-facing failure.
 * - For any other, non-auth endpoint, the auth interceptor transparently
 *   retries 401s via a token refresh before the caller ever sees the error.
 *   If that refresh itself fails, AuthService.refreshToken() shows its own
 *   "Session Expired" toast and logs out - so staying quiet here never
 *   leaves a real failure unreported, it just avoids reporting one
 *   speculatively before the retry has had a chance to run.
 * - A background call that 401s with no token at all while the user is
 *   sitting on a public /auth/* page (login/register/forgot/reset password)
 *   is expected - they haven't signed in yet, so "please sign in" is noise,
 *   not news.
 */
function isHandledElsewhere(req: HttpRequest<unknown>, authService: AuthService, router: Router): boolean {
  if (authService.isLoading) {
    return true;
  }

  const isNonRetriedAuthEndpoint = NON_RETRIED_AUTH_ENDPOINTS.some(endpoint => req.url.includes(endpoint));
  if (isNonRetriedAuthEndpoint) {
    return false;
  }

  if (authService.getAccessToken()) {
    // A token exists - the auth interceptor will attempt a silent refresh
    // before this is a final answer.
    return true;
  }

  // No stored token: nothing for the auth interceptor to refresh with, so
  // it will fail fast and log out without a toast of its own. Surface the
  // failure here unless the user is already on a public auth page, where
  // an unauthenticated background request is expected rather than broken.
  return router.url.startsWith('/auth');
}

/**
 * The single place in the app that shows error toasts for failed HTTP
 * requests. Callers that need to surface a more specific/business-aware
 * error message of their own (e.g. deployment tier-limit errors) should add
 * the `X-Skip-Error-Notification` header to that request rather than also
 * showing their own generic toast - this keeps every failure mapped to
 * exactly one toast.
 */
export const errorInterceptor: HttpInterceptorFn = (req, next) => {
  const notificationService = inject(NotificationService);
  const authService = inject(AuthService);
  const router = inject(Router);

  return next(req).pipe(
    retry(shouldRetry(req) ? 1 : 0),
    catchError((error: HttpErrorResponse) => {
      handleError(error, req, notificationService, authService, router);
      return throwError(() => error);
    })
  );
};

function handleError(
  error: HttpErrorResponse,
  req: HttpRequest<unknown>,
  notificationService: NotificationService,
  authService: AuthService,
  router: Router
): void {
  const skipNotification = shouldSkipNotification(req);

  if (!environment.production) {
    console.error('HTTP Error:', {
      url: req.url,
      method: req.method,
      status: error.status,
      statusText: error.statusText,
      error: error.error
    });
  }

  if (skipNotification) {
    return;
  }

  // 401s are handled specially further down (see isHandledElsewhere) since
  // the auth interceptor may silently retry them via a token refresh -
  // toasting here immediately would race that retry and fire even when the
  // request is about to succeed transparently.
  if (error.status === 401 && isHandledElsewhere(req, authService, router)) {
    return;
  }

  switch (error.status) {
    case 0:
      notificationService.error(
        'Network Error',
        'Unable to connect to server. Please check your internet connection.'
      );
      break;

    case 400:
      notificationService.error('Bad Request', parseHttpError(error, 'The request could not be processed.'));
      break;

    case 401:
      // Only reached when isHandledElsewhere() is false above - i.e. there's
      // no token to retry with, so this is a direct, unrecoverable auth
      // failure rather than something the auth interceptor is about to fix.
      notificationService.error('Authentication Required', 'Please sign in to continue.');
      break;

    case 403:
      notificationService.error('Access Denied', 'You do not have permission to perform this action.');
      break;

    case 404:
      notificationService.error('Not Found', 'The requested resource could not be found.');
      break;

    case 409:
      notificationService.warning('Conflict', parseHttpError(error, 'A conflict occurred while processing your request.'));
      break;

    case 422:
      notificationService.error('Validation Error', parseHttpError(error, 'Please check your input and try again.'));
      break;

    case 429:
      notificationService.warning('Rate Limit Exceeded', 'Too many requests. Please wait a moment and try again.');
      break;

    case 500:
      notificationService.error('Server Error', 'An internal server error occurred. Please try again later.');
      break;

    case 502:
    case 503:
    case 504:
      notificationService.error('Service Unavailable', 'The service is temporarily unavailable. Please try again later.');
      break;

    default:
      notificationService.error('Unexpected Error', parseHttpError(error, 'An unexpected error occurred.'));
      break;
  }
}
