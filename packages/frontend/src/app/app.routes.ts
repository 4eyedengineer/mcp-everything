import { Routes } from '@angular/router';
import { authGuard, noAuthGuard } from './core/guards/auth.guard';
import { landingGuard } from './core/guards/landing.guard';

export const routes: Routes = [
  {
    // Public marketing page. This used to `redirectTo: '/chat'`, which is
    // auth-guarded - so an anonymous visitor to the bare domain was bounced
    // straight to a login form with nothing explaining what the product was.
    // `landingGuard` keeps the old behaviour for signed-in users (they still
    // land on /chat) and shows the marketing page to everyone else.
    path: '',
    loadComponent: () => import('./features/landing/landing.component').then(m => m.LandingComponent),
    canActivate: [landingGuard],
    pathMatch: 'full',
    title: 'MCP Everything - Generate working MCP servers from any API',
    data: {
      title: 'Home',
      description:
        'Turn a GitHub repository, documentation site, service name or plain-English description into a working Model Context Protocol server, validated in a Docker sandbox.'
    }
  },
  {
    path: 'auth',
    loadChildren: () => import('./features/auth/auth.routes').then(m => m.AUTH_ROUTES),
    canActivate: [noAuthGuard],
    // No static `title` here on purpose: each child in auth.routes.ts now
    // sets its own real `title` (Sign In / Sign Up / Forgot Password / Reset
    // Password / Signing In) - a title on this parent would only matter if
    // resolution ever stopped here without reaching a child, which doesn't
    // happen (path: '' redirects into 'login').
    data: {
      title: 'Authentication',
      description: 'Sign in or create an account'
    }
  },
  {
    path: 'chat',
    loadChildren: () => import('./features/chat/chat.routes').then(m => m.CHAT_ROUTES),
    canActivate: [authGuard],
    title: 'Chat - MCP Everything',
    data: {
      title: 'Chat',
      description: 'Chat with AI to design and generate MCP servers'
    }
  },
  {
    path: 'explore',
    loadChildren: () => import('./features/explore/explore.routes').then(m => m.EXPLORE_ROUTES),
    title: 'Explore - MCP Everything',
    data: {
      title: 'Explore',
      description: 'Browse generated MCP servers'
    }
  },
  {
    path: 'servers',
    loadComponent: () => import('./features/servers/servers.component').then(m => m.ServersComponent),
    canActivate: [authGuard],
    title: 'My Servers - MCP Everything',
    data: {
      title: 'My Servers',
      description: 'Manage your hosted MCP servers'
    }
  },
  {
    path: 'account',
    loadComponent: () => import('./features/account/account.component').then(m => m.AccountComponent),
    canActivate: [authGuard],
    title: 'Account - MCP Everything',
    data: {
      title: 'Account',
      description: 'Manage your account and settings'
    }
  },
  {
    // Public, unauthenticated. Linked from the required consent checkbox on
    // the registration form (register.component.html) - that link used to
    // fall through to the wildcard redirect below because these routes did
    // not exist, so users were forced to agree to documents that were not
    // actually reachable.
    path: 'terms',
    loadComponent: () => import('./features/legal/terms.component').then(m => m.TermsComponent),
    title: 'Terms of Service - MCP Everything',
    data: {
      title: 'Terms of Service',
      description: 'The terms that apply to using MCP Everything to generate and host MCP servers.'
    }
  },
  {
    path: 'privacy',
    loadComponent: () => import('./features/legal/privacy.component').then(m => m.PrivacyComponent),
    title: 'Privacy Policy - MCP Everything',
    data: {
      title: 'Privacy Policy',
      description: 'What data MCP Everything collects, how it is used, and who it is shared with.'
    }
  },
  {
    path: 'reset-password',
    redirectTo: '/auth/reset-password',
    pathMatch: 'full'
  },
  {
    path: 'forgot-password',
    redirectTo: '/auth/forgot-password',
    pathMatch: 'full'
  },
  {
    // Unknown URLs now land on '/' rather than '/chat'. For a signed-in user
    // that is identical - landingGuard forwards them to /chat - but an
    // anonymous visitor following a stale link gets the marketing page
    // instead of an unexplained login form.
    path: '**',
    redirectTo: ''
  }
];
