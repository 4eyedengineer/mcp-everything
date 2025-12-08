import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { AppModule } from './app.module';
import { GlobalExceptionFilter } from './logging/global-exception.filter';
import { ErrorLoggingService } from './logging/error-logging.service';
import { StructuredLoggerService } from './logging/structured-logger.service';

async function bootstrap() {
  // Create structured logger for bootstrap
  const bootstrapLogger = new StructuredLoggerService().setContext('Bootstrap');

  const app = await NestFactory.create(AppModule, {
    // Enable raw body for Stripe webhooks
    rawBody: true,
    // Use structured logger for NestJS internal logging
    bufferLogs: true,
  });

  // Set up the structured logger as the application logger
  const structuredLogger = app.get(StructuredLoggerService);
  structuredLogger.setContext('NestApplication');
  app.useLogger(structuredLogger);

  // Enable CORS for frontend with SSE-specific configuration
  app.enableCors({
    origin: ['http://localhost:4200', 'http://localhost:8080', 'http://127.0.0.1:8080'],
    methods: 'GET,HEAD,PUT,PATCH,POST,DELETE,OPTIONS',
    credentials: true,
    exposedHeaders: ['Content-Type', 'Cache-Control', 'X-Accel-Buffering'],
    allowedHeaders: ['Content-Type', 'Authorization', 'Accept', 'X-Request-Id', 'X-Requested-With', 'X-App-Version', 'X-Client-Id', 'X-Session-Id'],
  });

  // Add SSE-specific headers middleware
  app.use((req, res, next) => {
    if (req.path.includes('/api/chat/stream/')) {
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      res.setHeader('X-Accel-Buffering', 'no'); // Disable nginx buffering
    }
    next();
  });

  // Enable validation globally
  app.useGlobalPipes(new ValidationPipe({
    whitelist: true,
    forbidNonWhitelisted: true,
    transform: true,
  }));

  // Register global exception filter for error logging
  const errorLoggingService = app.get(ErrorLoggingService);
  app.useGlobalFilters(new GlobalExceptionFilter(errorLoggingService));

  const port = process.env.PORT || 3000;
  await app.listen(port);

  bootstrapLogger.log(`MCP Everything Backend is running on: http://localhost:${port}`);
}

bootstrap().catch((error) => {
  const errorLogger = new StructuredLoggerService().setContext('Bootstrap');
  errorLogger.error('Failed to start application', error.stack);
  process.exit(1);
});