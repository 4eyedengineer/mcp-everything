import { Component } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { MatIconModule } from '@angular/material/icon';
import { MatTooltipModule } from '@angular/material/tooltip';

interface UserProfile {
  email: string;
  name: string;
  apiKey: string;
  serversGenerated: number;
  storageUsed: string;
}

interface Settings {
  emailNotifications: boolean;
  autoSave: boolean;
  darkMode: boolean;
}

@Component({
  selector: 'mcp-account',
  standalone: true,
  imports: [
    CommonModule,
    FormsModule,
    MatIconModule,
    MatTooltipModule
  ],
  templateUrl: './account.component.html',
  styleUrls: ['./account.component.scss']
})
export class AccountComponent {
  // Placeholder data - will be replaced with actual user data
  profile: UserProfile = {
    email: 'user@example.com',
    name: 'John Doe',
    apiKey: 'mcp_sk_xxxxxxxxxxxxxxxxxxxxxxxx',
    serversGenerated: 12,
    storageUsed: '245 MB'
  };

  settings: Settings = {
    emailNotifications: true,
    autoSave: true,
    darkMode: false
  };

  isEditingProfile = false;

  editProfile(): void {
    this.isEditingProfile = true;
  }

  saveProfile(): void {
    this.isEditingProfile = false;
    console.log('Saving profile:', this.profile);
    // TODO: Implement actual profile save logic
  }

  cancelEdit(): void {
    this.isEditingProfile = false;
    // TODO: Reset profile to original values
  }

  copyApiKey(): void {
    navigator.clipboard.writeText(this.profile.apiKey);
    console.log('API key copied to clipboard');
    // TODO: Show snackbar notification
  }

  regenerateApiKey(): void {
    console.log('Regenerating API key');
    // TODO: Implement API key regeneration
  }

  saveSettings(): void {
    console.log('Saving settings:', this.settings);
    // TODO: Implement settings save logic
  }

  deleteAccount(): void {
    if (confirm('Are you sure you want to delete your account? This action cannot be undone.')) {
      console.log('Deleting account');
      // TODO: Implement account deletion
    }
  }
}
