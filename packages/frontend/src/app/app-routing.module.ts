import { NgModule } from '@angular/core';
import { RouterModule, Routes } from '@angular/router';
import { AuthGuard } from './core/guards/auth.guard';
import { NoAuthGuard } from './core/guards/no-auth.guard';

const routes: Routes = [
  {
    path: '',
    redirectTo: '/chat',
    pathMatch: 'full'
  },
  {
    path: 'auth',
    loadChildren: () => import('./features/auth/auth.module').then(m => m.AuthModule),
    canActivate: [NoAuthGuard],
    data: {
      title: 'Authentication',
      description: 'Sign in or create an account'
    }
  },
  {
    path: 'chat',
    loadChildren: () => import('./features/chat/chat.module').then(m => m.ChatModule),
    canActivate: [AuthGuard],
    data: {
      title: 'Chat',
      description: 'Chat with AI to design and generate MCP servers'
    }
  },
  {
    path: 'explore',
    loadChildren: () => import('./features/explore/explore.module').then(m => m.ExploreModule),
    data: {
      title: 'Explore',
      description: 'Browse generated MCP servers'
    }
  },
  {
    path: 'servers',
    loadChildren: () => import('./features/servers/servers.module').then(m => m.ServersModule),
    canActivate: [AuthGuard],
    data: {
      title: 'My Servers',
      description: 'Manage your hosted MCP servers'
    }
  },
  {
    path: 'account',
    loadChildren: () => import('./features/account/account.module').then(m => m.AccountModule),
    canActivate: [AuthGuard],
    data: {
      title: 'Account',
      description: 'Manage your account and settings'
    }
  },
  {
    path: '**',
    redirectTo: '/chat'
  }
];

@NgModule({
  imports: [RouterModule.forRoot(routes, {
    enableTracing: false, // Set to true for debugging
    scrollPositionRestoration: 'top',
    anchorScrolling: 'enabled',
    scrollOffset: [0, 64], // Offset for fixed header
    onSameUrlNavigation: 'reload'
  })],
  exports: [RouterModule]
})
export class AppRoutingModule { }