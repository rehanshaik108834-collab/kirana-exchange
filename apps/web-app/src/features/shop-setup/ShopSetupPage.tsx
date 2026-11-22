import { FormEvent, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { AlertTriangle, CheckCircle2, Loader2, LogOut, MapPin } from 'lucide-react';
import { LanguageSwitcher } from '../../i18n/LanguageSwitcher';
import { signOut, waitForLinkedShop } from '../../lib/session';
import { useCreateShop } from '../auth/hooks';
import { MapPinPicker } from './MapPinPicker';

/** Values sent to the server stay English; only the labels are translated. */
const INDIAN_STATES = [
  'Telangana',
  'Andhra Pradesh',
  'Karnataka',
  'Maharashtra',
  'Tamil Nadu',
  'Delhi',
  'Gujarat',
  'Uttar Pradesh',
  'West Bengal',
] as const;
const GST_SCHEMES = ['COMPOSITION', 'REGULAR', 'UNREGISTERED'] as const;
type GstScheme = (typeof GST_SCHEMES)[number];

const FIELD =
  'min-h-11 w-full rounded-lg border border-slate-300 px-3 py-2 text-base focus:border-teal-600 focus:outline-none focus-visible:ring-2 focus-visible:ring-teal-600';

export function ShopSetupPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [linkState, setLinkState] = useState<'idle' | 'linking' | 'timeout'>('idle');

  const [name, setName] = useState('');
  const [address, setAddress] = useState('');
  const [state, setState] = useState<string>('Telangana');
  const [gstScheme, setGstScheme] = useState<GstScheme>('COMPOSITION');
  const [swapRadiusKm, setSwapRadiusKm] = useState(2);
  const [lat, setLat] = useState(17.412627);
  const [lng, setLng] = useState(78.448288);

  const createShopMutation = useCreateShop();

  const handleSubmit = (event: FormEvent) => {
    event.preventDefault();
    createShopMutation.mutate(
      { name: name.trim(), address: address.trim(), lat, lng, state, gstScheme, swapRadiusKm },
      {
        onSuccess: async () => {
          setLinkState('linking');
          const shopId = await waitForLinkedShop().catch(() => null);
          if (shopId) {
            navigate('/inventory', { replace: true });
          } else {
            setLinkState('timeout');
          }
        },
      },
    );
  };

  const handleSignOut = async () => {
    await signOut();
    queryClient.clear();
    navigate('/login', { replace: true });
  };

  return (
    <main className="mx-auto max-w-2xl px-4 py-8">
      <div className="mb-6 flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <h1 className="flex items-center gap-2 text-2xl font-bold text-slate-900">
            <MapPin className="h-6 w-6 shrink-0 text-teal-700" aria-hidden="true" />
            {t('shopSetup.title')}
          </h1>
          <p className="text-sm text-slate-700">{t('shopSetup.subtitle')}</p>
        </div>
        <div className="flex items-center gap-2">
          <LanguageSwitcher />
          <button
            type="button"
            onClick={handleSignOut}
            className="inline-flex min-h-11 items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3 text-sm font-medium text-slate-700 hover:bg-slate-50"
          >
            <LogOut className="h-4 w-4" aria-hidden="true" />
            {t('common.signOut')}
          </button>
        </div>
      </div>

      {createShopMutation.isSuccess && (
        <div
          role="status"
          className="mb-6 rounded-xl border border-teal-300 bg-teal-50 p-4 text-sm text-teal-900"
        >
          <div className="flex items-center gap-2 font-semibold">
            <CheckCircle2 className="h-5 w-5 text-teal-700" aria-hidden="true" />
            {linkState === 'timeout' ? t('shopSetup.savedSlow') : t('shopSetup.saved')}
            {linkState === 'linking' && (
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
            )}
          </div>
          <p className="mt-1 font-mono text-xs">
            {t('shopSetup.shopId')}: {createShopMutation.data.id}
          </p>
        </div>
      )}

      {createShopMutation.error && (
        <div
          role="alert"
          className="mb-6 flex items-start gap-2 rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-800"
        >
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
          <div>
            <p className="font-medium">{createShopMutation.error.detail}</p>
            {createShopMutation.error.correlationId && (
              <p className="mt-1 font-mono text-xs text-red-700">
                {t('common.ref', { id: createShopMutation.error.correlationId })}
              </p>
            )}
          </div>
        </div>
      )}

      <form
        onSubmit={handleSubmit}
        className="space-y-5 rounded-xl border border-slate-200 bg-white p-6 shadow-sm"
      >
        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <label className="mb-1 block text-sm font-medium text-slate-700" htmlFor="shopName">
              {t('shopSetup.shopName')}
            </label>
            <input
              id="shopName"
              type="text"
              required
              minLength={2}
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={t('shopSetup.shopNamePlaceholder')}
              className={FIELD}
            />
          </div>

          <div>
            <label className="mb-1 block text-sm font-medium text-slate-700" htmlFor="state">
              {t('shopSetup.state')}
            </label>
            <select
              id="state"
              value={state}
              onChange={(e) => setState(e.target.value)}
              className={FIELD}
            >
              {INDIAN_STATES.map((s) => (
                <option key={s} value={s}>
                  {t(`shopSetup.states.${s}`)}
                </option>
              ))}
            </select>
          </div>
        </div>

        <div>
          <label className="mb-1 block text-sm font-medium text-slate-700" htmlFor="address">
            {t('shopSetup.address')}
          </label>
          <input
            id="address"
            type="text"
            required
            minLength={5}
            value={address}
            onChange={(e) => setAddress(e.target.value)}
            placeholder={t('shopSetup.addressPlaceholder')}
            className={FIELD}
          />
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <label className="mb-1 block text-sm font-medium text-slate-700" htmlFor="gstScheme">
              {t('shopSetup.gstScheme')}
            </label>
            <select
              id="gstScheme"
              value={gstScheme}
              onChange={(e) => setGstScheme(e.target.value as GstScheme)}
              className={FIELD}
            >
              {GST_SCHEMES.map((g) => (
                <option key={g} value={g}>
                  {t(`shopSetup.gst.${g}`)}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label className="mb-1 block text-sm font-medium text-slate-700" htmlFor="radius">
              {t('shopSetup.radius', { km: swapRadiusKm })}
            </label>
            <input
              id="radius"
              type="range"
              min={0.5}
              max={10}
              step={0.5}
              value={swapRadiusKm}
              onChange={(e) => setSwapRadiusKm(Number(e.target.value))}
              className="mt-2 h-8 w-full accent-teal-700"
            />
          </div>
        </div>

        <div>
          <span className="mb-1 block text-sm font-medium text-slate-700">
            {t('shopSetup.dropPin')}
          </span>
          <MapPinPicker
            initialLat={lat}
            initialLng={lng}
            onLocationSelect={(newLat, newLng) => {
              setLat(newLat);
              setLng(newLng);
            }}
          />
        </div>

        <button
          type="submit"
          disabled={createShopMutation.isPending || linkState === 'linking'}
          className="min-h-12 w-full rounded-lg bg-teal-700 px-4 text-base font-semibold text-white hover:bg-teal-800 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {createShopMutation.isPending ? t('shopSetup.saving') : t('shopSetup.save')}
        </button>
      </form>
    </main>
  );
}
