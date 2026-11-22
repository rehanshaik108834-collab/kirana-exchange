import { FormEvent, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { AlertTriangle, CheckCircle2, LogOut, MapPin } from 'lucide-react';
import { useCreateShop } from '../auth/hooks';
import { MapPinPicker } from './MapPinPicker';

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
];

export function ShopSetupPage() {
  const navigate = useNavigate();
  const ownerId = localStorage.getItem('userId') || '';

  const [name, setName] = useState('');
  const [address, setAddress] = useState('');
  const [state, setState] = useState('Telangana');
  const [gstScheme, setGstScheme] = useState<'REGULAR' | 'COMPOSITION' | 'UNREGISTERED'>(
    'COMPOSITION',
  );
  const [swapRadiusKm, setSwapRadiusKm] = useState(2);
  const [lat, setLat] = useState(17.412627);
  const [lng, setLng] = useState(78.448288);

  const createShopMutation = useCreateShop();

  const handleSubmit = (event: FormEvent) => {
    event.preventDefault();
    createShopMutation.mutate({
      name: name.trim(),
      address: address.trim(),
      lat,
      lng,
      state,
      gstScheme,
      swapRadiusKm,
    });
  };

  const handleSignOut = () => {
    localStorage.clear();
    navigate('/login');
  };

  return (
    <main className="mx-auto max-w-2xl px-4 py-8">
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-bold text-slate-900">
            <MapPin className="h-6 w-6 text-teal-700" />
            Shop Profile &amp; Location Pin
          </h1>
          <p className="text-sm text-slate-600">
            Pin your kirana store on the map to match with nearby same-state shops.
          </p>
        </div>
        <button
          type="button"
          onClick={handleSignOut}
          className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50"
        >
          <LogOut className="h-3.5 w-3.5" />
          Sign Out
        </button>
      </div>

      {createShopMutation.isSuccess && (
        <div className="mb-6 rounded-xl border border-teal-300 bg-teal-50 p-4 text-sm text-teal-900">
          <div className="flex items-center gap-2 font-semibold">
            <CheckCircle2 className="h-5 w-5 text-teal-700" />
            Shop saved to shop_db &amp; ShopCreated outbox event queued!
          </div>
          <p className="mt-1 font-mono text-xs">
            Shop ID: {createShopMutation.data.id} ({createShopMutation.data.lat},{' '}
            {createShopMutation.data.lng}) — {createShopMutation.data.state}
          </p>
        </div>
      )}

      {createShopMutation.error && (
        <div className="mb-6 flex items-start gap-2 rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-800">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <div>
            <p className="font-medium">{createShopMutation.error.detail}</p>
            {createShopMutation.error.correlationId && (
              <p className="mt-1 font-mono text-xs text-red-600">
                Ref: {createShopMutation.error.correlationId}
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
              Shop Name
            </label>
            <input
              id="shopName"
              type="text"
              required
              minLength={2}
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Ramesh Kirana & General Store"
              className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-teal-600 focus:outline-none"
            />
          </div>

          <div>
            <label className="mb-1 block text-sm font-medium text-slate-700" htmlFor="state">
              State (Same-state swap boundary)
            </label>
            <select
              id="state"
              value={state}
              onChange={(e) => setState(e.target.value)}
              className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-teal-600 focus:outline-none"
            >
              {INDIAN_STATES.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          </div>
        </div>

        <div>
          <label className="mb-1 block text-sm font-medium text-slate-700" htmlFor="address">
            Street Address
          </label>
          <input
            id="address"
            type="text"
            required
            minLength={5}
            value={address}
            onChange={(e) => setAddress(e.target.value)}
            placeholder="12-4-88 Banjara Hills, Hyderabad"
            className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-teal-600 focus:outline-none"
          />
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <label className="mb-1 block text-sm font-medium text-slate-700" htmlFor="gstScheme">
              GST Scheme
            </label>
            <select
              id="gstScheme"
              value={gstScheme}
              onChange={(e) =>
                setGstScheme(e.target.value as 'REGULAR' | 'COMPOSITION' | 'UNREGISTERED')
              }
              className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-teal-600 focus:outline-none"
            >
              <option value="COMPOSITION">Composition</option>
              <option value="REGULAR">Regular</option>
              <option value="UNREGISTERED">Unregistered</option>
            </select>
          </div>

          <div>
            <label className="mb-1 block text-sm font-medium text-slate-700" htmlFor="radius">
              Swap Radius: {swapRadiusKm} km
            </label>
            <input
              id="radius"
              type="range"
              min={0.5}
              max={10}
              step={0.5}
              value={swapRadiusKm}
              onChange={(e) => setSwapRadiusKm(Number(e.target.value))}
              className="mt-2 w-full accent-teal-700"
            />
          </div>
        </div>

        <div>
          <span className="mb-1 block text-sm font-medium text-slate-700">
            Drop Shop Pin on Map
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
          disabled={createShopMutation.isPending || !ownerId}
          className="w-full rounded-lg bg-teal-700 px-4 py-2.5 text-sm font-semibold text-white hover:bg-teal-800 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {createShopMutation.isPending ? 'Saving shop...' : 'Save Shop Profile'}
        </button>
      </form>
    </main>
  );
}
