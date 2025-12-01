import { Injectable } from '@angular/core';
import { HttpInterceptor, HttpRequest, HttpHandler, HttpEvent } from '@angular/common/http';
import { Observable } from 'rxjs';
import { environment } from '../../../environments/environment';

@Injectable()
export class ApiInterceptor implements HttpInterceptor {
  intercept(req: HttpRequest<any>, next: HttpHandler): Observable<HttpEvent<any>> {
    // Add common headers
    let modifiedReq = req.clone({
      setHeaders: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'X-Requested-With': 'XMLHttpRequest',
        'X-App-Version': environment.version,
      }
    });

    // Add authentication token if available
    const token = this.getAuthToken();
    if (token) {
      modifiedReq = modifiedReq.clone({
        setHeaders: {
          'Authorization': `Bearer ${token}`
        }
      });
    }

    // Add request ID for tracking
    const requestId = this.generateRequestId();
    modifiedReq = modifiedReq.clone({
      setHeaders: {
        'X-Request-ID': requestId
      }
    });

    return next.handle(modifiedReq);
  }

  private getAuthToken(): string | null {
    try {
      return localStorage.getItem('mcp-auth-token');
    } catch {
      return null;
    }
  }

  private generateRequestId(): string {
    return `req-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  }
}