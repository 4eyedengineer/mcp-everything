import { HttpErrorResponse } from '@angular/common/http';

/**
 * Single source of truth for turning an `HttpErrorResponse` into a
 * human-readable message.
 *
 * Previously nearly every service (`ConversationService`, `DeploymentService`,
 * `HostingApiService`, `SubscriptionService`, ...) duplicated the same
 * client-error/backend-error/status-code fallback chain inside a private
 * `handleError`. This utility centralizes that logic; callers can still wrap
 * it in their own `catchError` to shape the returned observable (e.g. `of([])`
 * vs `throwError`) however they need.
 */
export function parseHttpError(
  error: HttpErrorResponse,
  fallback = 'An unexpected error occurred'
): string {
  // Client-side / network error (no response reached the server)
  if (error.error instanceof ErrorEvent) {
    return error.error.message;
  }

  if (typeof error.error?.message === 'string' && error.error.message) {
    return error.error.message;
  }

  if (typeof error.error?.error === 'string' && error.error.error) {
    return error.error.error;
  }

  switch (error.status) {
    case 0:
      return 'Unable to connect to server. Please check your internet connection.';
    case 404:
      return 'The requested resource could not be found.';
    case 429:
      return 'Too many requests. Please wait a moment before trying again.';
    case 500:
    case 502:
    case 503:
    case 504:
      return 'Server error. Please try again later.';
    default:
      return fallback;
  }
}
