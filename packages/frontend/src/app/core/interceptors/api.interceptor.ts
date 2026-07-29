import { HttpInterceptorFn } from '@angular/common/http';
import { environment } from '../../../environments/environment';

function generateRequestId(): string {
  return `req-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
}

/**
 * Adds common headers (content type, app version, request ID) to every
 * outgoing request.
 *
 * NOTE: Authorization header is intentionally NOT added here - that is the
 * sole responsibility of `authInterceptor` (via `AuthService.getAccessToken()`)
 * to avoid two interceptors racing to attach auth headers from different
 * sources.
 */
export const apiInterceptor: HttpInterceptorFn = (req, next) => {
  const modifiedReq = req.clone({
    setHeaders: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'X-Requested-With': 'XMLHttpRequest',
      'X-App-Version': environment.version,
      'X-Request-ID': generateRequestId()
    }
  });

  return next(modifiedReq);
};
