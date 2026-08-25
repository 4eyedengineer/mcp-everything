import { HttpInterceptorFn, HttpRequest } from '@angular/common/http';
import { inject } from '@angular/core';
import { finalize } from 'rxjs/operators';
import { LoadingService } from '../services/loading.service';

function shouldSkipLoading(req: HttpRequest<unknown>): boolean {
  const skipPaths = ['/health', '/status', '/ping'];
  const skipMethods = ['OPTIONS'];

  return (
    req.headers.has('X-Skip-Loading') ||
    skipPaths.some(path => req.url.includes(path)) ||
    skipMethods.includes(req.method) ||
    req.url.includes('/stream') ||
    req.url.includes('/poll')
  );
}

function generateLoadingKey(req: HttpRequest<unknown>): string {
  const urlPath = new URL(req.url, 'http://localhost').pathname;
  return `${req.method}-${urlPath}`;
}

function getLoadingMessage(req: HttpRequest<unknown>): string {
  const urlPath = new URL(req.url, 'http://localhost').pathname;

  const messageMap: Record<string, string> = {
    '/api/github/analyze': 'Analyzing repository...',
    '/api/generation/generate': 'Starting generation...',
    '/api/servers': req.method === 'GET' ? 'Loading servers...' : 'Updating server...',
    '/api/deployment': 'Deploying server...'
  };

  for (const [path, message] of Object.entries(messageMap)) {
    if (urlPath.includes(path)) {
      return message;
    }
  }

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

/**
 * Tracks in-flight requests via `LoadingService` so the app can show a global
 * (or per-key) loading indicator without every service/component managing its
 * own `isLoading` flag for HTTP calls.
 */
export const loadingInterceptor: HttpInterceptorFn = (req, next) => {
  const loadingService = inject(LoadingService);

  if (shouldSkipLoading(req)) {
    return next(req);
  }

  const loadingKey = generateLoadingKey(req);
  loadingService.start(loadingKey, getLoadingMessage(req));

  return next(req).pipe(
    finalize(() => {
      loadingService.stop(loadingKey);
    })
  );
};
