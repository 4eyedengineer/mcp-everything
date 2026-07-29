import { inject } from '@angular/core';
import { CanActivateFn, Router } from '@angular/router';
import { catchError, filter, map, of, switchMap, take } from 'rxjs';
import { AuthService } from '../services/auth.service';

/**
 * Factory for the two route guards that depend on auth state:
 * - `redirectTo: 'require-auth'`: only allow access when authenticated,
 *   otherwise redirect to `/auth/login` (replaces the old `AuthGuard`).
 * - `redirectTo: 'require-no-auth'`: only allow access when NOT
 *   authenticated, otherwise redirect to `/chat` (replaces `NoAuthGuard`).
 *
 * Both wait for `AuthService.isLoading$` to settle before checking
 * `isAuthenticated$`, exactly as the previous class-based guards did.
 */
function createAuthGuard(mode: 'require-auth' | 'require-no-auth'): CanActivateFn {
  return () => {
    const authService = inject(AuthService);
    const router = inject(Router);

    return authService.isLoading$.pipe(
      filter(isLoading => !isLoading),
      take(1),
      switchMap(() => authService.isAuthenticated$),
      take(1),
      map(isAuthenticated => {
        if (mode === 'require-auth') {
          if (isAuthenticated) {
            return true;
          }
          router.navigate(['/auth/login']);
          return false;
        }

        // require-no-auth
        if (isAuthenticated) {
          router.navigate(['/chat']);
          return false;
        }
        return true;
      }),
      catchError(() => {
        if (mode === 'require-auth') {
          // On error, redirect to login
          router.navigate(['/auth/login']);
          return of(false);
        }
        // On error, allow access (they can try to login)
        return of(true);
      })
    );
  };
}

/**
 * Only allow access to a route when the user is authenticated; otherwise
 * redirect to `/auth/login`.
 */
export const authGuard: CanActivateFn = createAuthGuard('require-auth');

/**
 * Prevent authenticated users from accessing auth pages (login, register,
 * etc.); redirects to `/chat` if already logged in.
 */
export const noAuthGuard: CanActivateFn = createAuthGuard('require-no-auth');
