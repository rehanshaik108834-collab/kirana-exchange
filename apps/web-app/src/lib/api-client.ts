import axios, { AxiosError, InternalAxiosRequestConfig } from 'axios';
import { v4 as uuidv4 } from 'uuid';

export interface ProblemDetails {
  type: string;
  title: string;
  status: number;
  detail: string;
  instance?: string;
  correlationId?: string;
  errors?: unknown[];
}

export class ApiProblemError extends Error {
  readonly status: number;
  readonly type: string;
  readonly title: string;
  readonly detail: string;
  readonly correlationId?: string;
  readonly retryAfterSeconds?: number;
  readonly errors?: unknown[];
  /** Full problem body, including extension members such as `available` or `currentVersion`. */
  readonly body?: Record<string, unknown>;

  constructor(params: {
    status: number;
    type: string;
    title: string;
    detail: string;
    correlationId?: string;
    retryAfterSeconds?: number;
    errors?: unknown[];
    body?: Record<string, unknown>;
  }) {
    super(params.detail);
    this.name = 'ApiProblemError';
    this.status = params.status;
    this.type = params.type;
    this.title = params.title;
    this.detail = params.detail;
    this.correlationId = params.correlationId;
    this.retryAfterSeconds = params.retryAfterSeconds;
    this.errors = params.errors;
    this.body = params.body;
  }
}

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || 'http://localhost:3001/v1';

export const apiClient = axios.create({
  baseURL: API_BASE_URL,
  headers: {
    'Content-Type': 'application/json',
  },
});

interface RetryableConfig extends InternalAxiosRequestConfig {
  _retry?: boolean;
}

// Single-flight promise ensures concurrent 401s share one refresh rotation
// and never replay an already-rotated refresh token (which revokes the family).
let refreshPromise: Promise<string> | null = null;

async function performSilentRefresh(): Promise<string> {
  const refreshToken = localStorage.getItem('refreshToken');
  if (!refreshToken) {
    throw new Error('No refresh token available');
  }

  const response = await axios.post<{ accessToken: string; refreshToken: string }>(
    `${API_BASE_URL}/auth/refresh`,
    { refreshToken },
    {
      headers: {
        'Content-Type': 'application/json',
        'X-Correlation-Id': uuidv4(),
      },
    },
  );

  localStorage.setItem('accessToken', response.data.accessToken);
  localStorage.setItem('refreshToken', response.data.refreshToken);
  return response.data.accessToken;
}

/**
 * Single-flight refresh for app code (e.g. after shop creation, to pick up the linked shopId).
 * Shares the interceptor's in-flight promise so a refresh token is never rotated twice.
 */
export function refreshSession(): Promise<string> {
  if (!refreshPromise) {
    refreshPromise = performSilentRefresh().finally(() => {
      refreshPromise = null;
    });
  }
  return refreshPromise;
}

function clearSessionAndRedirect() {
  localStorage.removeItem('accessToken');
  localStorage.removeItem('refreshToken');
  localStorage.removeItem('userId');
  localStorage.removeItem('userRole');
  if (typeof window !== 'undefined' && window.location.pathname !== '/login') {
    window.location.assign('/login');
  }
}

// Request Interceptor: Attach X-Correlation-Id and Bearer Token
apiClient.interceptors.request.use((config) => {
  config.headers['X-Correlation-Id'] = uuidv4();
  const token = localStorage.getItem('accessToken');
  if (token) {
    config.headers.Authorization = `Bearer ${token}`;
  }
  return config;
});

// Response Interceptor: Parse RFC 9457 Problem Details, handle 429 lockouts & 401 refresh
apiClient.interceptors.response.use(
  (response) => response,
  async (error: AxiosError<Partial<ProblemDetails>>) => {
    const status = error.response?.status ?? 0;
    const data = error.response?.data;
    const headers = error.response?.headers ?? {};
    const originalRequest = error.config as RetryableConfig | undefined;

    const isAuthEndpoint =
      originalRequest?.url?.includes('/auth/login') ||
      originalRequest?.url?.includes('/auth/register') ||
      originalRequest?.url?.includes('/auth/refresh');

    // 401 Unauthorized -> attempt single-flight silent refresh once on protected routes
    if (status === 401 && originalRequest && !originalRequest._retry && !isAuthEndpoint) {
      originalRequest._retry = true;
      try {
        const newAccessToken = await refreshSession();
        originalRequest.headers.Authorization = `Bearer ${newAccessToken}`;
        return apiClient(originalRequest);
      } catch {
        clearSessionAndRedirect();
      }
    }

    const correlationId =
      data?.correlationId ||
      (typeof headers['x-correlation-id'] === 'string' ? headers['x-correlation-id'] : undefined);

    const retryHeader = headers['retry-after'];
    const retryAfterSeconds = retryHeader ? Number.parseInt(String(retryHeader), 10) : undefined;

    if (status === 429) {
      const waitMsg =
        retryAfterSeconds && !Number.isNaN(retryAfterSeconds)
          ? `Too many attempts. Please wait ${retryAfterSeconds} seconds before trying again.`
          : 'Too many requests. Please wait a moment before trying again.';

      return Promise.reject(
        new ApiProblemError({
          status: 429,
          type: data?.type || '/errors/rate-limit-exceeded',
          title: data?.title || 'Too Many Requests',
          detail: waitMsg,
          correlationId,
          retryAfterSeconds: Number.isNaN(retryAfterSeconds ?? NaN) ? undefined : retryAfterSeconds,
        }),
      );
    }

    if (data && typeof data.type === 'string' && typeof data.title === 'string') {
      return Promise.reject(
        new ApiProblemError({
          status: data.status ?? status,
          type: data.type,
          title: data.title,
          detail: data.detail || data.title,
          correlationId,
          errors: data.errors,
          body: data as Record<string, unknown>,
        }),
      );
    }

    return Promise.reject(
      new ApiProblemError({
        status,
        type: `/errors/${status || 'network'}`,
        title: 'Request Failed',
        detail: error.message || 'Unable to reach Kirana Exchange server.',
        correlationId,
      }),
    );
  },
);
