import { NgModule } from '@angular/core';
import { RouterModule, Routes } from '@angular/router';
import { ExploreComponent } from './explore.component';
import { ServerDetailComponent } from './server-detail/server-detail.component';

const routes: Routes = [
  {
    path: '',
    component: ExploreComponent,
  },
  {
    path: ':slug',
    component: ServerDetailComponent,
    data: {
      title: 'Server Details',
      description: 'View MCP server details',
    },
  },
];

@NgModule({
  imports: [ExploreComponent, ServerDetailComponent, RouterModule.forChild(routes)],
})
export class ExploreModule {}
