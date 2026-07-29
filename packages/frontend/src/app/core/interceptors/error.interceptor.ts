import { HttpErrorResponse, HttpInterceptorFn, HttpRequest } from '@angular/common/http';
import { inject } from '@angular/core';
import { catchError, retry, throwError } from 'rxjs';
import { environment } from '../../../environments/environment';
import { NotificationService } from '../services/notification.service';
import { parseHttpError } from '../../shared/utils/http-error.util';

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
 * The single place in the app that shows error toasts for failed HTTP
 * requests. Callers that need to surface a more specific/business-aware
 * error message of their own (e.g. deployment tier-limit errors) should add
 * the `X-Skip-Error-Notification` header to that request rather than also
 * showing their own generic toast - this keeps every failure mapped to
 * exactly one toast.
 */
export const errorInterceptor: HttpInterceptorFn = (req, next) => {
  const notificationService = inject(NotificationService);

  return next(req).pipe(
    retry(shouldRetry(req) ? 1 : 0),
    catchError((error: HttpErrorResponse) => {
      handleError(error, req, notificationService);
      return throwError(() => error);
    })
  );
};

function handleError(
  error: HttpErrorResponse,
  req: HttpRequest<unknown>,
  notificationService: NotificationService
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
      notificationService.error('Authentication Required', 'Please sign in to continue.');
      // Could trigger logout here
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
