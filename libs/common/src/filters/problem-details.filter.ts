import { ExceptionFilter, Catch, ArgumentsHost, HttpException, HttpStatus } from '@nestjs/common';
import { Response, Request } from 'express';

@Catch()
export class ProblemDetailsFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();

    const status =
      exception instanceof HttpException ? exception.getStatus() : HttpStatus.INTERNAL_SERVER_ERROR;

    const correlationId = request.headers['x-correlation-id'] || 'missing-correlation-id';

    let detail = 'An unexpected error occurred';
    let errors = undefined;

    if (exception instanceof HttpException) {
      const responseData = exception.getResponse() as any;
      detail = responseData.message || responseData.error || exception.message;
      if (Array.isArray(responseData.message)) {
        errors = responseData.message; // Maps class-validator arrays natively
        detail = 'Validation failed';
      }
    } else if (exception instanceof Error) {
      detail = exception.message;
    }

    response
      .status(status)
      .header('Content-Type', 'application/problem+json')
      .json({
        type: `https://kirana-exchange.local/errors/${status}`,
        title: exception instanceof HttpException ? exception.name : 'Internal Server Error',
        status,
        detail,
        instance: request.url,
        correlationId,
        ...(errors && { errors }),
      });
  }
}
