import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { useTranslation } from 'react-i18next';
import i18n, { formatMoney } from './index';
import { LanguageSwitcher } from './LanguageSwitcher';
import en from './locales/en.json';
import hi from './locales/hi.json';
import te from './locales/te.json';

type Tree = { [key: string]: string | Tree };

/** Flattens nested resources into `a.b.c` → string. */
function flatten(tree: Tree, prefix = ''): Map<string, string> {
  const out = new Map<string, string>();
  for (const [k, v] of Object.entries(tree)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (typeof v === 'string') out.set(key, v);
    else for (const [ck, cv] of flatten(v, key)) out.set(ck, cv);
  }
  return out;
}

const placeholders = (s: string) => [...s.matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[1]).sort();
const tags = (s: string) => [...s.matchAll(/<(\w+)>/g)].map((m) => m[1]).sort();

const EN = flatten(en as Tree);

describe.each([
  ['te', te],
  ['hi', hi],
])('%s locale', (code, resource) => {
  const other = flatten(resource as Tree);

  it('has every English key and nothing extra', () => {
    expect([...other.keys()].filter((k) => !EN.has(k))).toEqual([]);
    expect([...EN.keys()].filter((k) => !other.has(k))).toEqual([]);
  });

  it('keeps the same {{placeholders}} and <tags> as English', () => {
    for (const [key, text] of EN) {
      const translated = other.get(key) ?? '';
      expect({ key, p: placeholders(translated) }).toEqual({ key, p: placeholders(text) });
      expect({ key, t: tags(translated) }).toEqual({ key, t: tags(text) });
    }
  });

  it(`is not just a copy of English (${code})`, () => {
    const words = (v: string) => v.replace(/\{\{\w+\}\}/g, '');
    const same = [...EN].filter(([k, v]) => other.get(k) === v && /[a-z]{4,}/i.test(words(v)));
    // Codes like MRP/EAN and brand names may stay English; whole sentences must not.
    expect(same.filter(([, v]) => v.includes(' ')).map(([k]) => k)).toEqual([]);
  });
});

function Probe() {
  const { t } = useTranslation();
  return <p>{t('inventory.title')}</p>;
}

describe('LanguageSwitcher', () => {
  afterEach(async () => {
    await act(() => i18n.changeLanguage('en'));
  });

  it('switches rendered text, <html lang> and the saved choice', async () => {
    render(
      <>
        <LanguageSwitcher />
        <Probe />
      </>,
    );
    expect(screen.getByText('My stock')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'తెలుగు' }));
    expect(screen.getByText(te.inventory.title)).toBeTruthy();
    expect(document.documentElement.lang).toBe('te');
    expect(localStorage.getItem('kx-lang')).toBe('te');
    expect(screen.getByRole('button', { name: 'తెలుగు' }).getAttribute('aria-pressed')).toBe('true');

    fireEvent.click(screen.getByRole('button', { name: 'हिन्दी' }));
    expect(screen.getByText(hi.inventory.title)).toBeTruthy();
    expect(document.documentElement.lang).toBe('hi');
  });

  it('pluralises with count', () => {
    expect(i18n.t('inventory.unsentSales', { count: 1 })).toBe('1 sale not synced yet');
    expect(i18n.t('inventory.unsentSales', { count: 3 })).toBe('3 sales not synced yet');
  });

  it('formats rupees per locale', () => {
    expect(formatMoney('45')).toBe('₹45.00');
  });
});
