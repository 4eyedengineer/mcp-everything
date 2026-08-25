import { Routes } from '@angular/router';
import { ExploreComponent } from './explore.component';
import { ServerDetailComponent } from './server-detail/server-detail.component';

export const EXPLORE_ROUTES: Routes = [
  {
    path: '',
    component: ExploreComponent
  },
  {
    path: ':slug',
    component: ServerDetailComponent,
    data: {
      title: 'Server Details',
      description: 'View MCP server details'
    }
  }
];
