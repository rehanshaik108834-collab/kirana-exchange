import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  Optional,
} from '@nestjs/common';
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Request } from 'express';

export const INTERNAL_SERVICE_HEADER = 'x-internal-service';
export const INTERNAL_TIMESTAMP_HEADER = 'x-internal-timestamp';
export const INTERNAL_SIGNATURE_HEADER = 'x-internal-signature';

export const DEFAULT_MAX_SKEW_SECONDS = 60;

export interface InternalIdentityInput {
  service: string;
  method: string;
  path: string;
  userId?: string | null;
  userRole?: string | null;
  shopId?: string | null;
  timestampSeconds?: number;
}

export interface SignedInternalHeaders {
  'x-internal-service': string;
  'x-internal-timestamp': string;
  'x-internal-signature': string;
}

export interface VerifyInternalOptions {
  secret?: string;
  maxSkewSeconds?: number;
  nowSeconds?: number;
  allowedServices?: readonly string[];
}

export interface VerifyInternalResult {
  valid: boolean;
  caller?: string;
  reason?: string;
}

export function getInternalAuthSecret(): string {
  return process.env.INTERNAL_AUTH_SECRET || 'dev-kirana-internal-hmac-secret-change-in-prod';
}

/** Strips query strings only? No — signs the full original path + query so query tampering is caught too. */
function buildCanonicalString(params: {
  service: string;
  timestamp: string;
  method: string;
  path: string;
  userId: string;
  userRole: string;
  shopId: string;
}): string {
  return [
    params.service.trim(),
    params.timestamp.trim(),
    params.method.toUpperCase(),
    params.path,
    params.userId,
    params.userRole,
    params.shopId,
  ].join('\n');
}

function readHeader(
  headers: Record<string, string | string[] | undefined>,
  name: string,
): string | undefined {
  const val = headers[name] ?? headers[name.toLowerCase()];
  if (Array.isArray(val)) return val[0];
  return typeof val === 'string' ? val : undefined;
}

/**
 * Generates HMAC-SHA256 signed internal service headers binding the caller service,
 * request method & URL, timestamp, and gateway-verified user identity claims.
 */
export function signInternalHeaders(
  input: InternalIdentityInput,
  secret = getInternalAuthSecret(),
): SignedInternalHeaders {
  const timestamp = String(input.timestampSeconds ?? Math.floor(Date.now() / 1000));
  const canonical = buildCanonicalString({
    service: input.service,
    timestamp,
    method: input.method,
    path: input.path,
    userId: input.userId ?? '',
    userRole: input.userRole ?? '',
    shopId: input.shopId ?? '',
  });

  const signature = createHmac('sha256', secret).update(canonical).digest('hex');

  return {
    'x-internal-service': input.service,
    'x-internal-timestamp': timestamp,
    'x-internal-signature': signature,
  };
}

/**
 * Verifies HMAC-SHA256 internal service headers in constant time and enforces a bounded
 * replay skew window so intercepted headers cannot be replayed or tampered with.
 */
export function verifyInternalSignature(
  headers: Record<string, string | string[] | undefined>,
  method: string,
  path: string,
  options: VerifyInternalOptions = {},
): VerifyInternalResult {
  const service = readHeader(headers, INTERNAL_SERVICE_HEADER);
  const timestamp = readHeader(headers, INTERNAL_TIMESTAMP_HEADER);
  const signature = readHeader(headers, INTERNAL_SIGNATURE_HEADER);

  if (!service || !timestamp || !signature) {
    return { valid: false, reason: 'MISSING_INTERNAL_AUTH_HEADERS' };
  }

  if (options.allowedServices && !options.allowedServices.includes(service)) {
    return { valid: false, caller: service, reason: 'SERVICE_NOT_ALLOWED' };
  }

  const tsNum = Number(timestamp);
  if (!Number.isInteger(tsNum) || tsNum <= 0) {
    return { valid: false, caller: service, reason: 'INVALID_TIMESTAMP' };
  }

  const nowSeconds = options.nowSeconds ?? Math.floor(Date.now() / 1000);
  const maxSkew = options.maxSkewSeconds ?? DEFAULT_MAX_SKEW_SECONDS;
  if (Math.abs(nowSeconds - tsNum) > maxSkew) {
    return { valid: false, caller: service, reason: 'TIMESTAMP_OUT_OF_WINDOW' };
  }

  const canonical = buildCanonicalString({
    service,
    timestamp,
    method,
    path,
    userId: readHeader(headers, 'x-user-id') ?? '',
    userRole: readHeader(headers, 'x-user-role') ?? '',
    shopId: readHeader(headers, 'x-shop-id') ?? '',
  });

  const expectedHex = createHmac('sha256', options.secret ?? getInternalAuthSecret())
    .update(canonical)
    .digest('hex');

  const actualBuf = Buffer.from(signature, 'hex');
  const expectedBuf = Buffer.from(expectedHex, 'hex');

  if (actualBuf.length !== expectedBuf.length || actualBuf.length === 0) {
    return { valid: false, caller: service, reason: 'SIGNATURE_MISMATCH' };
  }

  if (!timingSafeEqual(actualBuf, expectedBuf)) {
    return { valid: false, caller: service, reason: 'SIGNATURE_MISMATCH' };
  }

  return { valid: true, caller: service };
}

export interface InternalAuthGuardOptions {
  /** When true, every request MUST carry valid HMAC internal headers. Defaults to env REQUIRE_INTERNAL_AUTH === 'true'. */
  enforce?: boolean;
  allowedServices?: readonly string[];
  secret?: string;
  maxSkewSeconds?: number;
}

/**
 * Reusable NestJS guard for downstream microservices.
 * - Fail-closed whenever `enforce` is true OR whenever a signature header is present (catches spoofing even in dev).
 * - Skips `/health` probes automatically.
 */
@Injectable()
export class InternalAuthGuard implements CanActivate {
  private readonly enforce: boolean;
  private readonly allowedServices?: readonly string[];
  private readonly secret?: string;
  private readonly maxSkewSeconds?: number;

  constructor(@Optional() options: InternalAuthGuardOptions = {}) {
    this.enforce = options.enforce ?? process.env.REQUIRE_INTERNAL_AUTH === 'true';
    this.allowedServices = options.allowedServices;
    this.secret = options.secret;
    this.maxSkewSeconds = options.maxSkewSeconds;
  }

  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<Request>();
    const path = req.originalUrl || req.url || '/';

    if (path === '/health' || path.startsWith('/health?')) {
      return true;
    }

    const hasSignatureHeader = Boolean(req.headers[INTERNAL_SIGNATURE_HEADER]);
    if (!this.enforce && !hasSignatureHeader) {
      return true;
    }

    const result = verifyInternalSignature(
      req.headers as Record<string, string | string[] | undefined>,
      req.method,
      path,
      {
        secret: this.secret,
        allowedServices: this.allowedServices,
        maxSkewSeconds: this.maxSkewSeconds,
      },
    );

    if (!result.valid) {
      throw new ForbiddenException(`Invalid internal service authentication (${result.reason})`);
    }

    return true;
  }
}
