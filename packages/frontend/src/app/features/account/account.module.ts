import { NgModule } from '@angular/core';
import { RouterModule, Routes } from '@angular/router';
import { AccountComponent } from './account.component';

const routes: Routes = [
  {
    path: '',
    component: AccountComponent
  }
];

@NgModule({
  imports: [
    AccountComponent,
    RouterModule.forChild(routes)
  ]
})
export class AccountModule { }
