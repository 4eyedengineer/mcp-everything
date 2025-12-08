import { Injectable } from '@angular/core';
import { CanActivate, Router } from '@angular/router';
import { Observable, of } from 'rxjs';
import { map, take, catchError, filter, switchMap } from 'rxjs/operators';
import { AuthService } from '../services/auth.service';

/**
 * Guard to prevent authenticated users from accessing auth pages (login, register, etc.)
 * Redirects to the main app if user is already logged in.
 */
@Injectable({
  providedIn: 'root'
})
export class NoAuthGuard implements CanActivate {
  constructor(
    private authService: AuthService,
    private router: Router
  ) {}

  canActivate(): Observable<boolean> {
    // Wait for the auth service to finish loading before checking auth status
    return this.authService.isLoading$.pipe(
      filter(isLoading => !isLoading),
      take(1),
      switchMap(() => this.authService.isAuthenticated$),
      take(1),
      map(isAuthenticated => {
        if (isAuthenticated) {
          // User is already authenticated - redirect to main app
          this.router.navigate(['/chat']);
          return false;
        }
        // User is not authenticated - allow access to auth pages
        return true;
      }),
      catchError(() => {
        // On error, allow access (they can try to login)
        return of(true);
      })
    );
  }
}
