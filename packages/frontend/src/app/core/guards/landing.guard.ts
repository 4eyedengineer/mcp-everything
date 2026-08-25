import { inject } from '@angular/core';
import { CanActivateFn, Router } from '@angular/router';
import { catchError, filter, map, of, switchMap, take } from 'rxjs';
import { AuthService } from '../services/auth.service';

/**
 * Guard for the public landing page at `/`.
 *
 * An already-authenticated user has no use for the marketing page - they've
 * converted - so `/` sends them straight to `/chat`, which is what the route
 * used to do unconditionally (`path: '' -> redirectTo: '/chat'`). Anonymous
 * visitors, who previously bounced off `authGuard` into a login screen, now
 * get the landing page instead.
 *
 * Like `authGuard`/`noAuthGuard` this waits for `AuthService.isLoading$` to
 * settle first. For an anonymous visitor that settles synchronously (see
 * `AuthService.checkStoredToken` - no stored token means `isLoading$` emits
 * `false` immediately), so there is no network round trip in front of the
 * landing page's first paint.
 *
 * On error we deliberately fall through to the landing page rather than
 * redirecting: a broken auth backend should still leave the public marketing
 * page reachable.
 */
export const landingGuard: CanActivateFn = () => {
  const authService = inject(AuthService);
  const router = inject(Router);

  return authService.isLoading$.pipe(
    filter(isLoading => !isLoading),
    take(1),
    switchMap(() => authService.isAuthenticated$),
    take(1),
    map(isAuthenticated => {
      if (isAuthenticated) {
        router.navigate(['/chat']);
        return false;
      }
      return true;
    }),
    catchError(() => of(true))
  );
};
