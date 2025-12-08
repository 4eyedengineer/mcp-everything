import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';
import {
  SendEmailOptions,
  SendEmailResult,
  EmailConfig,
  PasswordResetEmailOptions,
  WelcomeEmailOptions,
} from './email.types';
import {
  getPasswordResetHtml,
  getPasswordResetText,
} from './templates/password-reset.template';

/**
 * Email Service
 *
 * Handles sending transactional emails using SendGrid.
 * In development mode, logs emails instead of sending.
 */
@Injectable()
export class EmailService {
  private readonly logger = new Logger(EmailService.name);
  private readonly config: EmailConfig;
  private readonly SENDGRID_API_URL = 'https://api.sendgrid.com/v3/mail/send';

  constructor(private readonly configService: ConfigService) {
    this.config = {
      provider: (this.configService.get<string>('EMAIL_PROVIDER') ||
        'sendgrid') as EmailConfig['provider'],
      apiKey: this.configService.get<string>('SENDGRID_API_KEY') || '',
      fromEmail:
        this.configService.get<string>('EMAIL_FROM') ||
        'noreply@mcp-everything.com',
      fromName:
        this.configService.get<string>('EMAIL_FROM_NAME') || 'MCP Everything',
      frontendUrl:
        this.configService.get<string>('FRONTEND_URL') ||
        'http://localhost:4200',
      isDevelopment:
        this.configService.get<string>('NODE_ENV') !== 'production',
    };

    if (!this.config.isDevelopment && !this.config.apiKey) {
      this.logger.warn(
        'No SENDGRID_API_KEY configured - emails will not be sent in production!',
      );
    }
  }

  /**
   * Send an email using the configured provider
   */
  async sendEmail(options: SendEmailOptions): Promise<SendEmailResult> {
    const from = options.from || this.config.fromEmail;
    const fromName = options.fromName || this.config.fromName;

    // In development mode, log instead of sending
    if (this.config.isDevelopment) {
      return this.logEmailInDev(options, from, fromName);
    }

    // Validate API key is present
    if (!this.config.apiKey) {
      this.logger.error('Cannot send email: SENDGRID_API_KEY not configured');
      return {
        success: false,
        error: 'Email service not configured',
      };
    }

    // Send via SendGrid
    return this.sendViaSendGrid(options, from, fromName);
  }

  /**
   * Send a password reset email
   */
  async sendPasswordResetEmail(
    options: PasswordResetEmailOptions,
  ): Promise<SendEmailResult> {
    const resetUrl = `${this.config.frontendUrl}/reset-password?token=${options.token}`;
    const expiresInHours = 1;

    const templateData = {
      resetUrl,
      userName: options.userName,
      expiresInHours,
    };

    return this.sendEmail({
      to: options.email,
      subject: 'Reset your MCP Everything password',
      html: getPasswordResetHtml(templateData),
      text: getPasswordResetText(templateData),
    });
  }

  /**
   * Send a welcome email after registration
   */
  async sendWelcomeEmail(options: WelcomeEmailOptions): Promise<SendEmailResult> {
    const html = this.getWelcomeEmailHtml(options.name);
    const text = this.getWelcomeEmailText(options.name);

    return this.sendEmail({
      to: options.email,
      subject: 'Welcome to MCP Everything!',
      html,
      text,
    });
  }

  /**
   * Log email details in development mode instead of sending
   */
  private logEmailInDev(
    options: SendEmailOptions,
    from: string,
    fromName: string,
  ): SendEmailResult {
    this.logger.log('='.repeat(60));
    this.logger.log('[DEV MODE] Email would be sent:');
    this.logger.log(`  From: ${fromName} <${from}>`);
    this.logger.log(`  To: ${options.to}`);
    this.logger.log(`  Subject: ${options.subject}`);
    this.logger.log('-'.repeat(60));
    this.logger.log('[DEV MODE] HTML Content:');
    // Log a truncated version for readability
    const truncatedHtml =
      options.html.length > 500
        ? options.html.substring(0, 500) + '... [truncated]'
        : options.html;
    this.logger.log(truncatedHtml);
    this.logger.log('='.repeat(60));

    return {
      success: true,
      messageId: `dev-${Date.now()}`,
    };
  }

  /**
   * Send email via SendGrid API
   */
  private async sendViaSendGrid(
    options: SendEmailOptions,
    from: string,
    fromName: string,
  ): Promise<SendEmailResult> {
    const payload = {
      personalizations: [
        {
          to: [{ email: options.to }],
        },
      ],
      from: {
        email: from,
        name: fromName,
      },
      subject: options.subject,
      content: [
        ...(options.text
          ? [{ type: 'text/plain', value: options.text }]
          : []),
        { type: 'text/html', value: options.html },
      ],
    };

    try {
      const response = await axios.post(this.SENDGRID_API_URL, payload, {
        headers: {
          Authorization: `Bearer ${this.config.apiKey}`,
          'Content-Type': 'application/json',
        },
      });

      // SendGrid returns 202 for accepted emails
      if (response.status === 202) {
        const messageId = response.headers['x-message-id'] || 'unknown';
        this.logger.log(
          `Email sent successfully to ${options.to} (messageId: ${messageId})`,
        );
        return {
          success: true,
          messageId,
        };
      }

      this.logger.warn(
        `Unexpected SendGrid response status: ${response.status}`,
      );
      return {
        success: false,
        error: `Unexpected status: ${response.status}`,
      };
    } catch (error) {
      const errorMessage =
        error.response?.data?.errors?.[0]?.message ||
        error.message ||
        'Unknown error';

      this.logger.error(`Failed to send email to ${options.to}: ${errorMessage}`);

      return {
        success: false,
        error: errorMessage,
      };
    }
  }

  /**
   * Generate welcome email HTML
   */
  private getWelcomeEmailHtml(name: string): string {
    return `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Welcome to MCP Everything</title>
  <style>
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
      line-height: 1.6;
      color: #333;
      max-width: 600px;
      margin: 0 auto;
      padding: 20px;
      background-color: #f5f5f5;
    }
    .container {
      background-color: #ffffff;
      border-radius: 8px;
      padding: 40px;
      box-shadow: 0 2px 4px rgba(0, 0, 0, 0.1);
    }
    .header {
      text-align: center;
      margin-bottom: 30px;
    }
    .logo {
      font-size: 24px;
      font-weight: bold;
      color: #6366f1;
    }
    h1 {
      color: #1f2937;
      font-size: 24px;
      margin-bottom: 20px;
    }
    p {
      margin-bottom: 16px;
      color: #4b5563;
    }
    .button {
      display: inline-block;
      background-color: #6366f1;
      color: #ffffff !important;
      text-decoration: none;
      padding: 14px 28px;
      border-radius: 6px;
      font-weight: 600;
      margin: 20px 0;
    }
    .button-container {
      text-align: center;
      margin: 30px 0;
    }
    .feature-list {
      margin: 20px 0;
      padding-left: 20px;
    }
    .feature-list li {
      margin-bottom: 10px;
      color: #4b5563;
    }
    .footer {
      margin-top: 40px;
      padding-top: 20px;
      border-top: 1px solid #e5e7eb;
      font-size: 12px;
      color: #9ca3af;
      text-align: center;
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <div class="logo">MCP Everything</div>
    </div>

    <h1>Welcome to MCP Everything!</h1>

    <p>Hi ${name},</p>

    <p>Thanks for joining MCP Everything! We're excited to help you generate MCP servers with AI.</p>

    <p>Here's what you can do:</p>
    <ul class="feature-list">
      <li><strong>Generate MCP Servers</strong> - Turn GitHub repos, APIs, and ideas into working MCP servers</li>
      <li><strong>Explore the Marketplace</strong> - Discover and subscribe to MCP servers built by the community</li>
      <li><strong>Deploy Instantly</strong> - One-click deployment to get your servers running</li>
    </ul>

    <div class="button-container">
      <a href="${this.config.frontendUrl}/chat" class="button">Start Building</a>
    </div>

    <p>If you have any questions, don't hesitate to reach out!</p>

    <div class="footer">
      <p>This email was sent by MCP Everything.</p>
      <p>&copy; ${new Date().getFullYear()} MCP Everything. All rights reserved.</p>
    </div>
  </div>
</body>
</html>
`.trim();
  }

  /**
   * Generate welcome email plain text
   */
  private getWelcomeEmailText(name: string): string {
    return `
Hi ${name},

Welcome to MCP Everything!

Thanks for joining. We're excited to help you generate MCP servers with AI.

Here's what you can do:
- Generate MCP Servers - Turn GitHub repos, APIs, and ideas into working MCP servers
- Explore the Marketplace - Discover and subscribe to MCP servers built by the community
- Deploy Instantly - One-click deployment to get your servers running

Get started: ${this.config.frontendUrl}/chat

If you have any questions, don't hesitate to reach out!

---
This email was sent by MCP Everything.
`.trim();
  }
}
