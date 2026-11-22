import { useTranslation } from 'react-i18next';
import { useRegisterSW } from 'virtual:pwa-register/react';
import { RefreshCw } from 'lucide-react';

/**
 * Registers the service worker and asks before activating a new version.
 * `registerType: 'prompt'` means an update never reloads the page on its own,
 * so a half-filled entry is never lost to a surprise reload.
 */
export function UpdatePrompt() {
  const { t } = useTranslation();
  const {
    needRefresh: [needRefresh, setNeedRefresh],
    updateServiceWorker,
  } = useRegisterSW();

  if (!needRefresh) return null;

  return (
    <div
      role="status"
      className="fixed inset-x-4 bottom-4 z-[1100] mx-auto flex max-w-md items-center gap-3 rounded-xl bg-slate-900 p-3 text-sm text-white shadow-lg"
    >
      <RefreshCw className="h-4 w-4 shrink-0" aria-hidden="true" />
      <p className="flex-1">{t('update.ready')}</p>
      <button
        type="button"
        onClick={() => setNeedRefresh(false)}
        className="min-h-11 rounded-lg px-3 font-medium text-slate-200 hover:bg-slate-800"
      >
        {t('update.later')}
      </button>
      <button
        type="button"
        onClick={() => void updateServiceWorker(true)}
        className="min-h-11 rounded-lg bg-teal-500 px-3 font-semibold text-slate-900 hover:bg-teal-400"
      >
        {t('update.reload')}
      </button>
    </div>
  );
}
