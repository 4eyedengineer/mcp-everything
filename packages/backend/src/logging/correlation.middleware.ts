import { Injectable, NestMiddleware } from '@nestjs/common';
import { Request, Response, NextFunction } from 'express';
import { v4 as uuid } from 'uuid';

/**
 * Header name for correlation ID
 */
export const CORRELATION_ID_HEADER = 'x-correlation-id';

/**
 * Request property name for correlation ID
 */
export const CORRELATION_ID_KEY = 'correlationId';

/**
 * Extended Express Request with correlation ID
 */
export interface RequestWithCorrelation extends Request {
  correlationId: string;
}

/**
 * CorrelationMiddleware
 *
 * Attaches a correlation ID to every incoming request for distributed tracing.
 * The correlation ID is:
 * - Read from the x-correlation-id header if provided by upstream services
 * - Generated as a new UUID if not present
 * - Attached to the request object for use in services
 * - Added to the response headers for downstream tracking
 *
 * This enables end-to-end request tracing across microservices and log aggregation.
 *
 * @example
 * // In a controller or service
 * async handleRequest(@Req() req: RequestWithCorrelation) {
 *   this.logger.log('Processing request', { correlationId: req.correlationId });
 * }
 */
@Injectable()
export class CorrelationMiddleware implements NestMiddleware {
  use(req: Request, res: Response, next: NextFunction): void {
    // Get correlation ID from header or generate new one
    const correlationId =
      (req.headers[CORRELATION_ID_HEADER] as string) || uuid();

    // Attach to request object for downstream use
    (req as RequestWithCorrelation).correlationId = correlationId;

    // Add to response headers for client tracking
    res.setHeader(CORRELATION_ID_HEADER, correlationId);

    next();
  }
}
