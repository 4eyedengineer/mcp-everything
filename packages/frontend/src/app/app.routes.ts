import { Routes } from '@angular/router';
import { authGuard, noAuthGuard } from './core/guards/auth.guard';

export const routes: Routes = [
  {
    path: '',
    redirectTo: '/chat',
    pathMatch: 'full'
  },
  {
    path: 'auth',
    loadChildren: () => import('./features/auth/auth.routes').then(m => m.AUTH_ROUTES),
    canActivate: [noAuthGuard],
    title: 'Sign In - MCP Everything',
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
    path: '**',
    redirectTo: '/chat'
  }
];
