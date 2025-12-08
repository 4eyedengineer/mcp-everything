/**
 * Password Reset Email Template
 *
 * Generates HTML and plain text versions of the password reset email.
 */

interface PasswordResetTemplateData {
  resetUrl: string;
  userName?: string;
  expiresInHours: number;
}

/**
 * Generate the HTML version of the password reset email
 */
export function getPasswordResetHtml(data: PasswordResetTemplateData): string {
  const greeting = data.userName ? `Hi ${data.userName},` : 'Hi,';

  return `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Reset Your Password</title>
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
    .button:hover {
      background-color: #4f46e5;
    }
    .button-container {
      text-align: center;
      margin: 30px 0;
    }
    .security-notice {
      background-color: #fef3c7;
      border-left: 4px solid #f59e0b;
      padding: 12px 16px;
      margin: 20px 0;
      font-size: 14px;
      color: #92400e;
    }
    .footer {
      margin-top: 40px;
      padding-top: 20px;
      border-top: 1px solid #e5e7eb;
      font-size: 12px;
      color: #9ca3af;
      text-align: center;
    }
    .link-fallback {
      word-break: break-all;
      font-size: 12px;
      color: #6b7280;
      margin-top: 20px;
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <div class="logo">MCP Everything</div>
    </div>

    <h1>Reset Your Password</h1>

    <p>${greeting}</p>

    <p>We received a request to reset the password for your MCP Everything account. Click the button below to create a new password:</p>

    <div class="button-container">
      <a href="${data.resetUrl}" class="button">Reset Password</a>
    </div>

    <p>This link will expire in <strong>${data.expiresInHours} hour${data.expiresInHours > 1 ? 's' : ''}</strong>.</p>

    <div class="security-notice">
      <strong>Security Notice:</strong> If you didn't request this password reset, you can safely ignore this email. Your password will remain unchanged.
    </div>

    <p class="link-fallback">
      If the button doesn't work, copy and paste this link into your browser:<br>
      ${data.resetUrl}
    </p>

    <div class="footer">
      <p>This email was sent by MCP Everything.</p>
      <p>If you have questions, contact us at support@mcp-everything.com</p>
      <p>&copy; ${new Date().getFullYear()} MCP Everything. All rights reserved.</p>
    </div>
  </div>
</body>
</html>
`.trim();
}

/**
 * Generate the plain text version of the password reset email
 */
export function getPasswordResetText(data: PasswordResetTemplateData): string {
  const greeting = data.userName ? `Hi ${data.userName},` : 'Hi,';

  return `
${greeting}

We received a request to reset the password for your MCP Everything account.

Reset your password by visiting this link:
${data.resetUrl}

This link will expire in ${data.expiresInHours} hour${data.expiresInHours > 1 ? 's' : ''}.

SECURITY NOTICE: If you didn't request this password reset, you can safely ignore this email. Your password will remain unchanged.

---
This email was sent by MCP Everything.
If you have questions, contact us at support@mcp-everything.com
`.trim();
}
