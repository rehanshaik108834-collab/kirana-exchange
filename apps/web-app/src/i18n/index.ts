import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import en from './locales/en.json';
import hi from './locales/hi.json';
import te from './locales/te.json';

/**
 * EN / TE / HI (US-15). English is the source of truth; Telugu and Hindi need native-speaker
 * review before real users (full translations beyond key screens are cut-order #2).
 */
export const LANGUAGES = [
  { code: 'en', short: 'EN', name: 'English', locale: 'en-IN' },
  { code: 'te', short: 'తె', name: 'తెలుగు', locale: 'te-IN' },
  { code: 'hi', short: 'हि', name: 'हिन्दी', locale: 'hi-IN' },
] as const;
export type LanguageCode = (typeof LANGUAGES)[number]['code'];

const STORAGE_KEY = 'kx-lang';

function storedLanguage(): LanguageCode {
  try {
    const value = localStorage.getItem(STORAGE_KEY);
    return LANGUAGES.some((l) => l.code === value) ? (value as LanguageCode) : 'en';
  } catch {
    return 'en';
  }
}

void i18n.use(initReactI18next).init({
  resources: { en: { translation: en }, te: { translation: te }, hi: { translation: hi } },
  lng: storedLanguage(),
  fallbackLng: 'en',
  interpolation: { escapeValue: false }, // React already escapes
  returnNull: false,
});

function applyLanguage(code: string): void {
  if (typeof document !== 'undefined') document.documentElement.lang = code;
  try {
    localStorage.setItem(STORAGE_KEY, code);
  } catch {
    // storage unavailable: the choice lasts for this session only
  }
}
applyLanguage(i18n.language);
i18n.on('languageChanged', applyLanguage);

export function currentLocale(): string {
  return LANGUAGES.find((l) => l.code === i18n.language)?.locale ?? 'en-IN';
}

export function formatMoney(value: number | string): string {
  return new Intl.NumberFormat(currentLocale(), { style: 'currency', currency: 'INR' }).format(
    Number(value),
  );
}

export function formatTime(epochMs: number): string {
  return new Intl.DateTimeFormat(currentLocale(), { hour: '2-digit', minute: '2-digit' }).format(
    epochMs,
  );
}

export function formatDateTime(iso: string): string {
  return new Intl.DateTimeFormat(currentLocale(), {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(iso));
}

export default i18n;
