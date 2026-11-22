import { useTranslation } from 'react-i18next';
import { LANGUAGES } from './index';

/** EN / తె / हि switcher. Large enough to tap; each button names its language for screen readers. */
export function LanguageSwitcher({ className = '' }: { className?: string }) {
  const { t, i18n } = useTranslation();
  return (
    <div
      role="group"
      aria-label={t('common.language')}
      className={`flex gap-1 rounded-lg border border-slate-200 bg-white p-1 text-sm ${className}`}
    >
      {LANGUAGES.map((lang) => {
        const active = i18n.language === lang.code;
        return (
          <button
            key={lang.code}
            type="button"
            lang={lang.code}
            aria-label={lang.name}
            aria-pressed={active}
            onClick={() => void i18n.changeLanguage(lang.code)}
            className={`min-h-11 min-w-11 rounded-md px-2 font-semibold ${
              active ? 'bg-teal-700 text-white' : 'text-slate-700 hover:bg-slate-100'
            }`}
          >
            {lang.short}
          </button>
        );
      })}
    </div>
  );
}
