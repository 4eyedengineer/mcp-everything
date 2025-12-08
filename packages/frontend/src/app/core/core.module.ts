import { NgModule, Optional, SkipSelf } from '@angular/core';
import { CommonModule } from '@angular/common';
import { HTTP_INTERCEPTORS } from '@angular/common/http';

// Services
import { ApiService } from './services/api.service';
import { AuthService } from './services/auth.service';
import { GitHubService } from './services/github.service';
import { McpGenerationService } from './services/mcp-generation.service';
import { McpServerService } from './services/mcp-server.service';
import { NotificationService } from './services/notification.service';
import { LoadingService } from './services/loading.service';
import { StateManagementService } from './services/state-management.service';

// Interceptors
import { ApiInterceptor } from './interceptors/api.interceptor';
import { AuthInterceptor } from './interceptors/auth.interceptor';
import { ErrorInterceptor } from './interceptors/error.interceptor';
import { LoadingInterceptor } from './interceptors/loading.interceptor';

// Guards
import { AuthGuard } from './guards/auth.guard';
import { NoAuthGuard } from './guards/no-auth.guard';

@NgModule({
  imports: [CommonModule],
  providers: [
    // Core Services
    ApiService,
    AuthService,
    GitHubService,
    McpGenerationService,
    McpServerService,
    NotificationService,
    LoadingService,
    StateManagementService,

    // Guards
    AuthGuard,
    NoAuthGuard,

    // HTTP Interceptors (order matters: auth should come first to add token)
    {
      provide: HTTP_INTERCEPTORS,
      useClass: AuthInterceptor,
      multi: true
    },
    {
      provide: HTTP_INTERCEPTORS,
      useClass: ApiInterceptor,
      multi: true
    },
    {
      provide: HTTP_INTERCEPTORS,
      useClass: ErrorInterceptor,
      multi: true
    },
    {
      provide: HTTP_INTERCEPTORS,
      useClass: LoadingInterceptor,
      multi: true
    }
  ]
})
export class CoreModule {
  constructor(@Optional() @SkipSelf() parentModule: CoreModule) {
    if (parentModule) {
      throw new Error('CoreModule is already loaded. Import it in the AppModule only');
    }
  }
}