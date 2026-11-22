import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus } from '@nestjs/common';
import type { Request, Response } from 'express';
import pino from 'pino';

export const PROBLEM_TYPE_BASE = 'https://kirana-exchange.local/errors/';

/**
 * Domain error carrying an explicit RFC 9457 problem type slug from docs/error-catalogue.md,
 * e.g. `version-conflict`, `insufficient-unreserved-stock`, `idempotency-conflict`.
 */
export class DomainProblemException extends HttpException {
  constructor(
    readonly problemType: string,
    readonly problemTitle: string,
    status: HttpStatus,
    detail: string,
    readonly extensions: Record<string, unknown> = {},
  ) {
    super({ message: detail, error: problemTitle }, status);
  }
}

export const VersionConflictProblem = (detail: string, extensions?: Record<string, unknown>) =>
  new DomainProblemException(
    'version-conflict',
    'Optimistic Concurrency Conflict',
    HttpStatus.CONFLICT,
    detail,
    extensions,
  );

export const InsufficientStockProblem = (detail: string, extensions?: Record<string, unknown>) =>
  new DomainProblemException(
    'insufficient-unreserved-stock',
    'Insufficient Unreserved Stock',
    HttpStatus.CONFLICT,
    detail,
    extensions,
  );

export const IdempotencyConflictProblem = (detail: string) =>
  new DomainProblemException(
    'idempotency-conflict',
    'Idempotency Key Reused',
    HttpStatus.CONFLICT,
    detail,
  );

/** Default slug and title per status, aligned with docs/error-catalogue.md where it defines one. */
const STATUS_PROBLEMS: Record<number, { slug: string; title: string }> = {
  400: { slug: 'bad-request', title: 'Bad Request' },
  401: { slug: 'unauthorized', title: 'Unauthorized' },
  403: { slug: 'forbidden', title: 'Forbidden' },
  404: { slug: 'not-found', title: 'Not Found' },
  409: { slug: 'conflict', title: 'Conflict' },
  429: { slug: 'rate-limit-exceeded', title: 'Too Many Requests' },
  500: { slug: 'internal-error', title: 'Internal Server Error' },
  503: { slug: 'service-unavailable', title: 'Service Unavailable' },
};

@Catch()
export class ProblemDetailsFilter implements ExceptionFilter {
  private readonly logger = pino({ name: 'problem-details' });

  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();

    const status =
      exception instanceof HttpException ? exception.getStatus() : HttpStatus.INTERNAL_SERVER_ERROR;
    const correlationIdHeader = request.headers['x-correlation-id'];
    const correlationId =
      typeof correlationIdHeader === 'string' ? correlationIdHeader : 'missing-correlation-id';

    const fallback = STATUS_PROBLEMS[status] ?? { slug: `http-${status}`, title: 'Error' };
    let slug = fallback.slug;
    let title = fallback.title;
    let detail = 'An unexpected error occurred';
    let errors: unknown[] | undefined;
    let extensions: Record<string, unknown> = {};

    if (exception instanceof DomainProblemException) {
      slug = exception.problemType;
      title = exception.problemTitle;
      detail = String((exception.getResponse() as { message?: unknown }).message ?? detail);
      extensions = exception.extensions;
    } else if (exception instanceof HttpException) {
      const body = exception.getResponse() as string | { message?: unknown; error?: unknown };
      const message = typeof body === 'string' ? body : body.message;
      if (Array.isArray(message)) {
        // class-validator failures (ValidationPipe)
        slug = 'validation-failed';
        title = 'Bad Request';
        detail = 'Validation failed';
        errors = message;
      } else {
        detail = String(message ?? exception.message);
      }
    } else {
      // Never leak internal error text (SQL, stack details) to clients; log it with the correlationId.
      this.logger.error(
        {
          correlationId,
          err: exception instanceof Error ? exception.message : String(exception),
          stack: exception instanceof Error ? exception.stack : undefined,
          path: request.url,
        },
        'Unhandled exception',
      );
    }

    response
      .status(status)
      .header('Content-Type', 'application/problem+json')
      .json({
        type: `${PROBLEM_TYPE_BASE}${slug}`,
        title,
        status,
        detail,
        instance: request.url,
        correlationId,
        ...extensions,
        ...(errors && { errors }),
      });
  }
}
