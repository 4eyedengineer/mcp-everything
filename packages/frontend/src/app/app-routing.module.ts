import { NgModule } from '@angular/core';
import { RouterModule, Routes } from '@angular/router';
import { AuthGuard } from './core/guards/auth.guard';

const routes: Routes = [
  {
    path: '',
    redirectTo: '/chat',
    pathMatch: 'full'
  },
  {
    path: 'chat',
    loadChildren: () => import('./features/chat/chat.module').then(m => m.ChatModule),
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
    path: 'account',
    loadChildren: () => import('./features/account/account.module').then(m => m.AccountModule),
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