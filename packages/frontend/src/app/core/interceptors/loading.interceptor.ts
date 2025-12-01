import { Injectable } from '@angular/core';
import { HttpInterceptor, HttpRequest, HttpHandler, HttpEvent } from '@angular/common/http';
import { Observable } from 'rxjs';
import { finalize } from 'rxjs/operators';
import { LoadingService } from '../services/loading.service';

@Injectable()
export class LoadingInterceptor implements HttpInterceptor {
  constructor(private loadingService: LoadingService) {}

  intercept(req: HttpRequest<any>, next: HttpHandler): Observable<HttpEvent<any>> {
    // Skip loading indicator for specific requests
    if (this.shouldSkipLoading(req)) {
      return next.handle(req);
    }

    // Generate unique loading key for this request
    const loadingKey = this.generateLoadingKey(req);

    // Start loading
    this.loadingService.start(loadingKey, this.getLoadingMessage(req));

    return next.handle(req).pipe(
      finalize(() => {
        // Stop loading when request completes (success or error)
        this.loadingService.stop(loadingKey);
      })
    );
  }

  private shouldSkipLoading(req: HttpRequest<any>): boolean {
    // Skip loading for these conditions
    const skipPaths = [
      '/health',
      '/status',
      '/ping'
    ];

    const skipMethods = ['OPTIONS'];

    return (
      req.headers.has('X-Skip-Loading') ||
      skipPaths.some(path => req.url.includes(path)) ||
      skipMethods.includes(req.method) ||
      req.url.includes('/stream') ||
      req.url.includes('/poll')
    );
  }

  private generateLoadingKey(req: HttpRequest<any>): string {
    // Create a unique key based on method and URL
    const urlPath = new URL(req.url, 'http://localhost').pathname;
    return `${req.method}-${urlPath}`;
  }

  private getLoadingMessage(req: HttpRequest<any>): string {
    // Return appropriate loading message based on request
    const urlPath = new URL(req.url, 'http://localhost').pathname;

    const messageMap: Record<string, string> = {
      '/api/github/analyze': 'Analyzing repository...',
      '/api/generation/generate': 'Starting generation...',
      '/api/servers': req.method === 'GET' ? 'Loading servers...' : 'Updating server...',
      '/api/deployment': 'Deploying server...',
    };

    // Find matching message
    for (const [path, message] of Object.entries(messageMap)) {
      if (urlPath.includes(path)) {
        return message;
      }
    }

    // Default messages by HTTP method
    switch (req.method) {
      case 'GET':
        return 'Loading...';
      case 'POST':
        return 'Creating...';
      case 'PUT':
      case 'PATCH':
        return 'Updating...';
      case 'DELETE':
        return 'Deleting...';
      default:
        return 'Processing...';
    }
  }
}