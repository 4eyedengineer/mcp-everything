import { NgModule } from '@angular/core';
import { RouterModule, Routes } from '@angular/router';
import { LoginComponent } from './components/login/login.component';
import { RegisterComponent } from './components/register/register.component';
import { OAuthCallbackComponent } from './components/oauth-callback/oauth-callback.component';
import { ForgotPasswordComponent } from './components/forgot-password/forgot-password.component';
import { ResetPasswordComponent } from './components/reset-password/reset-password.component';

const routes: Routes = [
  {
    path: '',
    redirectTo: 'login',
    pathMatch: 'full'
  },
  {
    path: 'login',
    component: LoginComponent,
    data: {
      title: 'Sign In',
      description: 'Sign in to your MCP Everything account'
    }
  },
  {
    path: 'register',
    component: RegisterComponent,
    data: {
      title: 'Sign Up',
      description: 'Create your MCP Everything account'
    }
  },
  {
    path: 'callback',
    component: OAuthCallbackComponent,
    data: {
      title: 'Signing In',
      description: 'Completing authentication'
    }
  },
  {
    path: 'forgot-password',
    component: ForgotPasswordComponent,
    data: {
      title: 'Forgot Password',
      description: 'Reset your password'
    }
  },
  {
    path: 'reset-password',
    component: ResetPasswordComponent,
    data: {
      title: 'Reset Password',
      description: 'Set a new password'
    }
  }
];

@NgModule({
  imports: [
    LoginComponent,
    RegisterComponent,
    OAuthCallbackComponent,
    ForgotPasswordComponent,
    ResetPasswordComponent,
    RouterModule.forChild(routes)
  ]
})
export class AuthModule { }
