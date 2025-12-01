import { Injectable } from '@angular/core';
import { HttpInterceptor, HttpRequest, HttpHandler, HttpEvent, HttpErrorResponse } from '@angular/common/http';
import { Observable, throwError } from 'rxjs';
import { catchError, retry } from 'rxjs/operators';
import { NotificationService } from '../services/notification.service';
import { environment } from '../../../environments/environment';

@Injectable()
export class ErrorInterceptor implements HttpInterceptor {
  constructor(private notificationService: NotificationService) {}

  intercept(req: HttpRequest<any>, next: HttpHandler): Observable<HttpEvent<any>> {
    return next.handle(req).pipe(
      retry(this.shouldRetry(req) ? 1 : 0),
      catchError((error: HttpErrorResponse) => {
        this.handleError(error, req);
        return throwError(() => error);
      })
    );
  }

  private handleError(error: HttpErrorResponse, req: HttpRequest<any>): void {
    // Don't show notifications for specific endpoints
    const skipNotification = this.shouldSkipNotification(req);

    if (!environment.production) {
      console.error('HTTP Error:', {
        url: req.url,
        method: req.method,
        status: error.status,
        statusText: error.statusText,
        error: error.error
      });
    }

    if (!skipNotification) {
      switch (error.status) {
        case 0:
          this.notificationService.error(
            'Network Error',
            'Unable to connect to server. Please check your internet connection.'
          );
          break;

        case 400:
          this.notificationService.error(
            'Bad Request',
            error.error?.message || 'The request could not be processed.'
          );
          break;

        case 401:
          this.notificationService.error(
            'Authentication Required',
            'Please sign in to continue.'
          );
          // Could trigger logout here
          break;

        case 403:
          this.notificationService.error(
            'Access Denied',
            'You do not have permission to perform this action.'
          );
          break;

        case 404:
          this.notificationService.error(
            'Not Found',
            'The requested resource could not be found.'
          );
          break;

        case 409:
          this.notificationService.warning(
            'Conflict',
            error.error?.message || 'A conflict occurred while processing your request.'
          );
          break;

        case 422:
          this.notificationService.error(
            'Validation Error',
            error.error?.message || 'Please check your input and try again.'
          );
          break;

        case 429:
          this.notificationService.warning(
            'Rate Limit Exceeded',
            'Too many requests. Please wait a moment and try again.'
          );
          break;

        case 500:
          this.notificationService.error(
            'Server Error',
            'An internal server error occurred. Please try again later.'
          );
          break;

        case 502:
        case 503:
        case 504:
          this.notificationService.error(
            'Service Unavailable',
            'The service is temporarily unavailable. Please try again later.'
          );
          break;

        default:
          this.notificationService.error(
            'Unexpected Error',
            error.error?.message || 'An unexpected error occurred.'
          );
          break;
      }
    }
  }

  private shouldRetry(req: HttpRequest<any>): boolean {
    // Only retry GET requests
    return req.method === 'GET' && !req.url.includes('/stream');
  }

  private shouldSkipNotification(req: HttpRequest<any>): boolean {
    // Skip notifications for these endpoints
    const skipPaths = [
      '/health',
      '/status',
      '/auth/validate'
    ];

    return skipPaths.some(path => req.url.includes(path)) ||
           req.headers.has('X-Skip-Error-Notification');
  }
}