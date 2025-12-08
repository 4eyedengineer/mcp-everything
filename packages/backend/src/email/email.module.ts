import { Module } from '@nestjs/common';
import { EmailService } from './email.service';

/**
 * Email Module
 *
 * Provides email sending capabilities for transactional emails.
 * Uses SendGrid as the email provider.
 *
 * In development mode (NODE_ENV !== 'production'), emails are logged
 * to the console instead of being sent.
 *
 * Required environment variables for production:
 * - SENDGRID_API_KEY: Your SendGrid API key
 * - EMAIL_FROM: Default from email address
 * - EMAIL_FROM_NAME: Default from name
 * - FRONTEND_URL: URL for building email links
 */
@Module({
  providers: [EmailService],
  exports: [EmailService],
})
export class EmailModule {}
