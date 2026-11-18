import { Injectable, NestMiddleware } from '@nestjs/common';
import { Request, Response, NextFunction } from 'express';
import { v4 as uuidv4 } from 'uuid';

@Injectable()
export class CorrelationIdMiddleware implements NestMiddleware {
  use(req: Request, res: Response, next: NextFunction) {
    // Read existing ID (e.g., from a trusted upstream) or generate a new one
    const incoming = req.headers['x-correlation-id'];
    const correlationId =
      typeof incoming === 'string' && incoming.trim().length > 0 ? incoming.trim() : uuidv4();

    // Attach to request so downstream NestJS controllers/services can extract it
    req.headers['x-correlation-id'] = correlationId;

    // Attach to response so the client/React PWA can log it for support requests
    res.setHeader('X-Correlation-Id', correlationId);

    next();
  }
}
