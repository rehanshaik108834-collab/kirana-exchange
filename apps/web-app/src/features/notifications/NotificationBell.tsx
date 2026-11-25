import { useCallback, useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Bell, CheckCheck, X } from 'lucide-react';
import { apiClient, ApiProblemError } from '../../lib/api-client';
import { currentClaims } from '../../lib/session';

export interface NotificationItem {
  id: string;
  shopId: string;
  type: string;
  channel: 'SSE' | 'EMAIL' | 'BATCHED';
  payload: {
    title?: string;
    body?: string;
  };
  readAt: string | null;
  sentAt: string;
}

interface NotificationListResponse {
  notifications: NotificationItem[];
  unreadCount: number;
}

export function NotificationBell() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);

  const shopId = currentClaims()?.shopId ?? null;
  const enabled = Boolean(shopId);

  const feed = useQuery<NotificationListResponse, ApiProblemError>({
    queryKey: ['notifications', shopId],
    enabled,
    staleTime: 30_000,
    queryFn: async ({ signal }) =>
      (await apiClient.get<NotificationListResponse>('/notifications', { signal })).data,
  });

  const markRead = useMutation({
    mutationFn: async (id: string) => (await apiClient.post(`/notifications/${id}/read`)).data,
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['notifications'] });
    },
  });

  const markAllRead = useMutation({
    mutationFn: async () => (await apiClient.post('/notifications/read-all')).data,
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['notifications'] });
    },
  });

  const refreshFeed = useCallback(() => {
    void qc.invalidateQueries({ queryKey: ['notifications', shopId] });
  }, [qc, shopId]);

  // Live SSE notification stream (authenticated fetch; silently degrades if offline)
  useEffect(() => {
    if (!enabled || typeof window === 'undefined' || typeof fetch !== 'function') return;
    const token = localStorage.getItem('accessToken');
    if (!token) return;

    const controller = new AbortController();
    const baseUrl = apiClient.defaults?.baseURL || 'http://localhost:3001/v1';

    void (async () => {
      try {
        const res = await fetch(`${baseUrl}/notifications/stream`, {
          headers: {
            Accept: 'text/event-stream',
            Authorization: `Bearer ${token}`,
          },
          signal: controller.signal,
        });
        const reader = res.body?.getReader();
        if (!res.ok || !reader) return;

        const decoder = new TextDecoder();
        let buffer = '';
        while (!controller.signal.aborted) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const frames = buffer.split('\n\n');
          buffer = frames.pop() ?? '';
          if (frames.some((frame) => frame.includes('notification.new'))) {
            refreshFeed();
          }
        }
      } catch {
        // Offline or aborted
      }
    })();

    return () => controller.abort();
  }, [enabled, refreshFeed]);

  const unreadCount = feed.data?.unreadCount ?? 0;
  const items = feed.data?.notifications ?? [];

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((prev) => !prev)}
        aria-expanded={open}
        aria-label={t('notifications.bellAria', { count: unreadCount })}
        className="relative inline-flex min-h-11 min-w-11 items-center justify-center rounded-lg border border-slate-300 bg-white text-slate-700 hover:bg-slate-50"
      >
        <Bell aria-hidden="true" className="h-4 w-4" />
        {unreadCount > 0 && (
          <span className="absolute -right-1 -top-1 inline-flex min-w-5 items-center justify-center rounded-full bg-red-600 px-1 text-[10px] font-bold text-white">
            {unreadCount > 99 ? '99+' : unreadCount}
          </span>
        )}
      </button>

      {open && (
        <div
          role="dialog"
          aria-label={t('notifications.title')}
          className="absolute right-0 z-[1100] mt-2 w-80 max-w-[calc(100vw-2rem)] rounded-xl border border-slate-200 bg-white p-3 shadow-lg"
        >
          <div className="flex items-center justify-between gap-2 border-b border-slate-200 pb-2">
            <p className="text-sm font-bold text-slate-900">
              {t('notifications.title')}{' '}
              {unreadCount > 0 ? `(${t('notifications.unread', { count: unreadCount })})` : ''}
            </p>
            <div className="flex items-center gap-1">
              {unreadCount > 0 && (
                <button
                  type="button"
                  onClick={() => void markAllRead.mutateAsync()}
                  className="inline-flex items-center gap-1 rounded px-2 py-1 text-xs font-semibold text-teal-800 hover:bg-teal-50"
                >
                  <CheckCheck aria-hidden="true" className="h-3.5 w-3.5" />
                  {t('notifications.markAllRead')}
                </button>
              )}
              <button
                type="button"
                onClick={() => setOpen(false)}
                aria-label={t('notifications.close')}
                className="rounded p-1 text-slate-500 hover:bg-slate-100"
              >
                <X aria-hidden="true" className="h-4 w-4" />
              </button>
            </div>
          </div>

          {items.length === 0 ? (
            <p className="py-6 text-center text-xs text-slate-600">{t('notifications.empty')}</p>
          ) : (
            <ul className="mt-2 max-h-72 space-y-2 overflow-y-auto">
              {items.map((item) => (
                <li
                  key={item.id}
                  className={`rounded-lg border p-2.5 text-xs ${
                    item.readAt
                      ? 'border-slate-100 bg-slate-50 text-slate-700'
                      : 'border-teal-200 bg-teal-50/60 text-slate-900'
                  }`}
                >
                  <div className="flex items-start justify-between gap-2">
                    <p className="font-semibold">{item.payload?.title ?? item.type}</p>
                    {!item.readAt && (
                      <button
                        type="button"
                        onClick={() => void markRead.mutateAsync(item.id)}
                        className="shrink-0 text-[11px] font-semibold text-teal-800 underline"
                      >
                        {t('notifications.markRead')}
                      </button>
                    )}
                  </div>
                  {item.payload?.body && <p className="mt-1 text-slate-700">{item.payload.body}</p>}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
