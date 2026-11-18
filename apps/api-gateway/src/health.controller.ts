import { Controller, Get, Headers } from '@nestjs/common';

@Controller()
export class HealthController {
  @Get('health')
  check(@Headers('x-correlation-id') correlationId: string) {
    return {
      status: 'ok',
      service: 'api-gateway',
      correlationId,
    };
  }
}
