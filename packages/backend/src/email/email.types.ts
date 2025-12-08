/**
 * Email Service Types
 *
 * Type definitions for the email service module.
 */

/**
 * Supported email providers
 */
export type EmailProvider = 'sendgrid' | 'ses' | 'mailgun';

/**
 * Options for sending an email
 */
export interface SendEmailOptions {
  /** Recipient email address */
  to: string;
  /** Email subject line */
  subject: string;
  /** HTML content of the email */
  html: string;
  /** Plain text fallback (optional) */
  text?: string;
  /** From email address (optional, uses default if not provided) */
  from?: string;
  /** From name (optional, uses default if not provided) */
  fromName?: string;
}

/**
 * Result of an email send operation
 */
export interface SendEmailResult {
  /** Whether the email was sent successfully */
  success: boolean;
  /** Message ID from the provider (if available) */
  messageId?: string;
  /** Error message if sending failed */
  error?: string;
}

/**
 * Email configuration from environment variables
 */
export interface EmailConfig {
  /** Email provider to use */
  provider: EmailProvider;
  /** API key for the provider */
  apiKey: string;
  /** Default from email address */
  fromEmail: string;
  /** Default from name */
  fromName: string;
  /** Frontend URL for building links */
  frontendUrl: string;
  /** Whether we're in development mode */
  isDevelopment: boolean;
}

/**
 * Password reset email options
 */
export interface PasswordResetEmailOptions {
  /** User's email address */
  email: string;
  /** Password reset token */
  token: string;
  /** User's name (optional) */
  userName?: string;
}

/**
 * Welcome email options
 */
export interface WelcomeEmailOptions {
  /** User's email address */
  email: string;
  /** User's name */
  name: string;
}
