import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { EmailService } from './email.service';
import axios from 'axios';

// Mock axios
jest.mock('axios');
const mockedAxios = axios as jest.Mocked<typeof axios>;

describe('EmailService', () => {
  let service: EmailService;
  let configService: ConfigService;

  const mockConfigValues: Record<string, string | undefined> = {
    EMAIL_PROVIDER: 'sendgrid',
    SENDGRID_API_KEY: 'SG.test-api-key',
    EMAIL_FROM: 'test@mcp-everything.com',
    EMAIL_FROM_NAME: 'MCP Everything Test',
    FRONTEND_URL: 'http://localhost:4200',
    NODE_ENV: 'development',
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        EmailService,
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn((key: string) => mockConfigValues[key]),
          },
        },
      ],
    }).compile();

    service = module.get<EmailService>(EmailService);
    configService = module.get<ConfigService>(ConfigService);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('constructor', () => {
    it('should be defined', () => {
      expect(service).toBeDefined();
    });

    it('should load configuration from ConfigService', () => {
      expect(configService.get).toHaveBeenCalledWith('EMAIL_PROVIDER');
      expect(configService.get).toHaveBeenCalledWith('SENDGRID_API_KEY');
      expect(configService.get).toHaveBeenCalledWith('EMAIL_FROM');
      expect(configService.get).toHaveBeenCalledWith('EMAIL_FROM_NAME');
      expect(configService.get).toHaveBeenCalledWith('FRONTEND_URL');
      expect(configService.get).toHaveBeenCalledWith('NODE_ENV');
    });
  });

  describe('sendEmail', () => {
    it('should log email in development mode instead of sending', async () => {
      const logSpy = jest.spyOn((service as any).logger, 'log');

      const result = await service.sendEmail({
        to: 'user@example.com',
        subject: 'Test Subject',
        html: '<p>Test content</p>',
      });

      expect(result.success).toBe(true);
      expect(result.messageId).toMatch(/^dev-\d+$/);
      expect(logSpy).toHaveBeenCalled();
      expect(mockedAxios.post).not.toHaveBeenCalled();
    });

    it('should send email via SendGrid in production mode', async () => {
      // Override to production mode
      mockConfigValues.NODE_ENV = 'production';

      // Re-create service with production config
      const module: TestingModule = await Test.createTestingModule({
        providers: [
          EmailService,
          {
            provide: ConfigService,
            useValue: {
              get: jest.fn((key: string) => mockConfigValues[key]),
            },
          },
        ],
      }).compile();

      const productionService = module.get<EmailService>(EmailService);

      mockedAxios.post.mockResolvedValueOnce({
        status: 202,
        headers: { 'x-message-id': 'sg-message-123' },
      });

      const result = await productionService.sendEmail({
        to: 'user@example.com',
        subject: 'Test Subject',
        html: '<p>Test content</p>',
      });

      expect(result.success).toBe(true);
      expect(result.messageId).toBe('sg-message-123');
      expect(mockedAxios.post).toHaveBeenCalledWith(
        'https://api.sendgrid.com/v3/mail/send',
        expect.objectContaining({
          personalizations: [{ to: [{ email: 'user@example.com' }] }],
          from: {
            email: 'test@mcp-everything.com',
            name: 'MCP Everything Test',
          },
          subject: 'Test Subject',
        }),
        expect.objectContaining({
          headers: {
            Authorization: 'Bearer SG.test-api-key',
            'Content-Type': 'application/json',
          },
        }),
      );

      // Reset to development
      mockConfigValues.NODE_ENV = 'development';
    });

    it('should return error when SendGrid API fails', async () => {
      mockConfigValues.NODE_ENV = 'production';

      const module: TestingModule = await Test.createTestingModule({
        providers: [
          EmailService,
          {
            provide: ConfigService,
            useValue: {
              get: jest.fn((key: string) => mockConfigValues[key]),
            },
          },
        ],
      }).compile();

      const productionService = module.get<EmailService>(EmailService);

      mockedAxios.post.mockRejectedValueOnce({
        response: {
          data: {
            errors: [{ message: 'Invalid API key' }],
          },
        },
      });

      const result = await productionService.sendEmail({
        to: 'user@example.com',
        subject: 'Test Subject',
        html: '<p>Test content</p>',
      });

      expect(result.success).toBe(false);
      expect(result.error).toBe('Invalid API key');

      mockConfigValues.NODE_ENV = 'development';
    });

    it('should return error when API key is not configured in production', async () => {
      mockConfigValues.NODE_ENV = 'production';
      mockConfigValues.SENDGRID_API_KEY = undefined;

      const module: TestingModule = await Test.createTestingModule({
        providers: [
          EmailService,
          {
            provide: ConfigService,
            useValue: {
              get: jest.fn((key: string) => mockConfigValues[key]),
            },
          },
        ],
      }).compile();

      const productionService = module.get<EmailService>(EmailService);

      const result = await productionService.sendEmail({
        to: 'user@example.com',
        subject: 'Test Subject',
        html: '<p>Test content</p>',
      });

      expect(result.success).toBe(false);
      expect(result.error).toBe('Email service not configured');

      // Reset
      mockConfigValues.NODE_ENV = 'development';
      mockConfigValues.SENDGRID_API_KEY = 'SG.test-api-key';
    });
  });

  describe('sendPasswordResetEmail', () => {
    it('should send password reset email with correct template', async () => {
      const sendEmailSpy = jest.spyOn(service, 'sendEmail');

      const result = await service.sendPasswordResetEmail({
        email: 'user@example.com',
        token: 'reset-token-123',
        userName: 'John',
      });

      expect(result.success).toBe(true);
      expect(sendEmailSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          to: 'user@example.com',
          subject: 'Reset your MCP Everything password',
        }),
      );

      // Verify the HTML contains the reset URL with token
      const callArgs = sendEmailSpy.mock.calls[0][0];
      expect(callArgs.html).toContain('reset-token-123');
      expect(callArgs.html).toContain('http://localhost:4200/reset-password');
      expect(callArgs.html).toContain('John');
    });

    it('should work without userName', async () => {
      const sendEmailSpy = jest.spyOn(service, 'sendEmail');

      await service.sendPasswordResetEmail({
        email: 'user@example.com',
        token: 'reset-token-456',
      });

      const callArgs = sendEmailSpy.mock.calls[0][0];
      expect(callArgs.html).not.toContain('Hi undefined');
      expect(callArgs.html).toContain('Hi,'); // Generic greeting
    });
  });

  describe('sendWelcomeEmail', () => {
    it('should send welcome email with user name', async () => {
      const sendEmailSpy = jest.spyOn(service, 'sendEmail');

      const result = await service.sendWelcomeEmail({
        email: 'newuser@example.com',
        name: 'Jane',
      });

      expect(result.success).toBe(true);
      expect(sendEmailSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          to: 'newuser@example.com',
          subject: 'Welcome to MCP Everything!',
        }),
      );

      const callArgs = sendEmailSpy.mock.calls[0][0];
      expect(callArgs.html).toContain('Jane');
      expect(callArgs.html).toContain('http://localhost:4200/chat');
    });
  });
});
