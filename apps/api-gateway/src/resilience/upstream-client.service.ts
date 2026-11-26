import { Injectable, OnApplicationShutdown, ServiceUnavailableException } from '@nestjs/common';
import CircuitBreaker from 'opossum';
import pino from 'pino';

export type BreakerStatus = 'closed' | 'open' | 'halfOpen';

export interface UpstreamClientOptions {
  timeoutMs?: number;
  resetTimeoutMs?: number;
  errorThresholdPercentage?: number;
  volumeThreshold?: number;
  maxGetRetries?: number;
  retryBaseDelayMs?: number;
}

class UpstreamTransientError extends Error {
  constructor(
    message: string,
    readonly statusCode?: number,
  ) {
    super(message);
    this.name = 'UpstreamTransientError';
  }
}

const RETRYABLE_STATUSES = new Set([502, 503, 504]);
const IDEMPOTENT_METHODS = new Set(['GET', 'HEAD']);

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Per-service resilient HTTP client for `api-gateway`:
 * - Wraps each downstream microservice in an isolated `opossum` circuit breaker.
 * - Retries transient network errors and 502/503/504 with exponential backoff strictly
 *   on idempotent `GET`/`HEAD` requests.
 * - Never trips the circuit breaker on 4xx client errors.
 * - Fails fast with HTTP 503 (`ServiceUnavailableException`) when a service's breaker is open.
 */
@Injectable()
export class UpstreamClientService implements OnApplicationShutdown {
  private readonly logger = pino({ name: 'gateway-upstream-client' });
  private readonly breakers = new Map<string, CircuitBreaker<[string, RequestInit], Response>>();
  private readonly opts: Required<UpstreamClientOptions>;

  constructor(options: UpstreamClientOptions = {}) {
    this.opts = {
      timeoutMs: options.timeoutMs ?? Number(process.env.UPSTREAM_TIMEOUT_MS || 10_000),
      resetTimeoutMs:
        options.resetTimeoutMs ?? Number(process.env.BREAKER_RESET_TIMEOUT_MS || 15_000),
      errorThresholdPercentage:
        options.errorThresholdPercentage ?? Number(process.env.BREAKER_ERROR_THRESHOLD || 50),
      volumeThreshold: options.volumeThreshold ?? Number(process.env.BREAKER_VOLUME_THRESHOLD || 5),
      maxGetRetries: options.maxGetRetries ?? Number(process.env.UPSTREAM_MAX_GET_RETRIES || 2),
      retryBaseDelayMs:
        options.retryBaseDelayMs ?? Number(process.env.UPSTREAM_RETRY_BASE_MS || 50),
    };
  }

  private getOrCreateBreaker(serviceKey: string): CircuitBreaker<[string, RequestInit], Response> {
    const existing = this.breakers.get(serviceKey);
    if (existing) return existing;

    const action = async (url: string, init: RequestInit): Promise<Response> => {
      const method = (init.method || 'GET').toUpperCase();
      const maxAttempts = IDEMPOTENT_METHODS.has(method) ? this.opts.maxGetRetries + 1 : 1;

      let lastErr: unknown;
      for (let attempt = 0; attempt < maxAttempts; attempt++) {
        try {
          const response = await fetch(url, init);
          if (RETRYABLE_STATUSES.has(response.status)) {
            if (attempt < maxAttempts - 1) {
              await sleep(this.opts.retryBaseDelayMs * 2 ** attempt);
              continue;
            }
            throw new UpstreamTransientError(
              `Downstream ${serviceKey} responded with HTTP ${response.status}`,
              response.status,
            );
          }
          return response;
        } catch (err) {
          if (err instanceof UpstreamTransientError) {
            throw err;
          }
          lastErr = err;
          if (attempt < maxAttempts - 1) {
            await sleep(this.opts.retryBaseDelayMs * 2 ** attempt);
            continue;
          }
          throw new UpstreamTransientError(
            `Downstream ${serviceKey} unreachable: ${(err as Error)?.message ?? 'network error'}`,
          );
        }
      }

      throw new UpstreamTransientError(
        `Downstream ${serviceKey} unreachable: ${(lastErr as Error)?.message ?? 'unknown'}`,
      );
    };

    const breaker = new CircuitBreaker(action, {
      name: `gateway-${serviceKey}`,
      timeout: this.opts.timeoutMs,
      resetTimeout: this.opts.resetTimeoutMs,
      errorThresholdPercentage: this.opts.errorThresholdPercentage,
      volumeThreshold: this.opts.volumeThreshold,
    });

    breaker.on('open', () => {
      this.logger.warn({ serviceKey }, 'Circuit breaker OPENED — failing fast with 503');
    });
    breaker.on('halfOpen', () => {
      this.logger.info({ serviceKey }, 'Circuit breaker HALF-OPEN — probing downstream service');
    });
    breaker.on('close', () => {
      this.logger.info({ serviceKey }, 'Circuit breaker CLOSED — downstream service healthy');
    });

    this.breakers.set(serviceKey, breaker);
    return breaker;
  }

  isOpen(serviceKey: string): boolean {
    return Boolean(this.breakers.get(serviceKey)?.opened);
  }

  getBreakerStates(): Record<string, BreakerStatus> {
    const states: Record<string, BreakerStatus> = {};
    for (const [key, breaker] of this.breakers.entries()) {
      states[key] = breaker.opened ? 'open' : breaker.halfOpen ? 'halfOpen' : 'closed';
    }
    return states;
  }

  async execute(serviceKey: string, url: string, init: RequestInit): Promise<Response> {
    const breaker = this.getOrCreateBreaker(serviceKey);
    try {
      return await breaker.fire(url, init);
    } catch (err) {
      const code = (err as { code?: string })?.code;
      if (code === 'EOPENBREAKER') {
        throw new ServiceUnavailableException(
          `Service '${serviceKey}' is temporarily unavailable (circuit open)`,
        );
      }
      if (code === 'ETIMEDOUT') {
        throw new ServiceUnavailableException(
          `Service '${serviceKey}' timed out after ${this.opts.timeoutMs}ms`,
        );
      }
      throw new ServiceUnavailableException('Downstream service is currently unavailable');
    }
  }

  onApplicationShutdown(): void {
    this.shutdown();
  }

  shutdown(): void {
    for (const breaker of this.breakers.values()) {
      breaker.shutdown();
    }
    this.breakers.clear();
  }
}
