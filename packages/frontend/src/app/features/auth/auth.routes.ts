import { Routes } from '@angular/router';
import { LoginComponent } from './components/login/login.component';
import { RegisterComponent } from './components/register/register.component';
import { OAuthCallbackComponent } from './components/oauth-callback/oauth-callback.component';
import { ForgotPasswordComponent } from './components/forgot-password/forgot-password.component';
import { ResetPasswordComponent } from './components/reset-password/reset-password.component';

export const AUTH_ROUTES: Routes = [
  {
    path: '',
    redirectTo: 'login',
    pathMatch: 'full'
  },
  {
    path: 'login',
    component: LoginComponent,
    title: 'Sign In - MCP Everything',
    data: {
      title: 'Sign In',
      description: 'Sign in to your MCP Everything account'
    }
  },
  {
    path: 'register',
    component: RegisterComponent,
    title: 'Sign Up - MCP Everything',
    data: {
      title: 'Sign Up',
      description: 'Create your MCP Everything account'
    }
  },
  {
    path: 'callback',
    component: OAuthCallbackComponent,
    title: 'Signing In - MCP Everything',
    data: {
      title: 'Signing In',
      description: 'Completing authentication'
    }
  },
  {
    path: 'forgot-password',
    component: ForgotPasswordComponent,
    title: 'Forgot Password - MCP Everything',
    data: {
      title: 'Forgot Password',
      description: 'Reset your password'
    }
  },
  {
    path: 'reset-password',
    component: ResetPasswordComponent,
    title: 'Reset Password - MCP Everything',
    data: {
      title: 'Reset Password',
      description: 'Set a new password'
    }
  }
];
