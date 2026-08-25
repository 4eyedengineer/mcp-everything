import { ApplicationConfig, inject, provideAppInitializer } from '@angular/core';
import { provideAnimations } from '@angular/platform-browser/animations';
import { provideHttpClient, withInterceptors } from '@angular/common/http';
import { provideRouter, withInMemoryScrolling, withRouterConfig } from '@angular/router';

import { routes } from './app.routes';
import { authInterceptor } from './core/interceptors/auth.interceptor';
import { apiInterceptor } from './core/interceptors/api.interceptor';
import { errorInterceptor } from './core/interceptors/error.interceptor';
import { loadingInterceptor } from './core/interceptors/loading.interceptor';
import { ThemeService } from './core/services/theme.service';
import { AuthService } from './core/services/auth.service';
import { IconRegistryService } from './core/services/icon-registry.service';

export const appConfig: ApplicationConfig = {
  providers: [
    provideRouter(
      routes,
      withInMemoryScrolling({
        scrollPositionRestoration: 'top',
        anchorScrolling: 'enabled'
      }),
      // Note: the previous `scrollOffset: [0, 64]` option is applied via
      // `ViewportScroller.setOffset()` in AppComponent, since the standalone
      // router providers have no direct equivalent.
      withRouterConfig({ onSameUrlNavigation: 'reload' })
    ),
    // Order matters: auth should run first to attach the token before the
    // other interceptors see the request.
    provideHttpClient(withInterceptors([authInterceptor, apiInterceptor, errorInterceptor, loadingInterceptor])),
    provideAnimations(),
    // Apply the persisted/system theme before the app renders.
    provideAppInitializer(() => inject(ThemeService).init()),
    // Register brand SVG icons (GitHub/Google OAuth marks) before first paint.
    provideAppInitializer(() => inject(IconRegistryService).init()),
    // Restore the auth session outside AuthService's constructor - the auth
    // interceptor injects AuthService, so the restore request must not run
    // while the service is still being instantiated (circular DI).
    provideAppInitializer(() => inject(AuthService).init())
  ]
};
