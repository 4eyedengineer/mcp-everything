import { Injectable } from '@angular/core';
import { CanActivate, CanActivateChild, Router } from '@angular/router';
import { Observable, of } from 'rxjs';
import { map, catchError } from 'rxjs/operators';
import { StateManagementService } from '../services/state-management.service';

@Injectable({
  providedIn: 'root'
})
export class AuthGuard implements CanActivate, CanActivateChild {
  constructor(
    private stateService: StateManagementService,
    private router: Router
  ) {}

  canActivate(): Observable<boolean> {
    return this.checkAuth();
  }

  canActivateChild(): Observable<boolean> {
    return this.checkAuth();
  }

  private checkAuth(): Observable<boolean> {
    return this.stateService.selectUser().pipe(
      map(user => {
        if (user.isAuthenticated) {
          return true;
        } else {
          // For MVP, we'll skip authentication
          // In production, redirect to login
          // this.router.navigate(['/auth/login']);
          // return false;

          // For now, allow all access
          return true;
        }
      }),
      catchError(() => {
        // On error, redirect to login
        this.router.navigate(['/auth/login']);
        return of(false);
      })
    );
  }
}