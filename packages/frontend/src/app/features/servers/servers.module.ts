import { NgModule } from '@angular/core';
import { RouterModule, Routes } from '@angular/router';
import { ServersComponent } from './servers.component';

const routes: Routes = [
  {
    path: '',
    component: ServersComponent
  }
];

@NgModule({
  imports: [
    ServersComponent,
    RouterModule.forChild(routes)
  ]
})
export class ServersModule { }
