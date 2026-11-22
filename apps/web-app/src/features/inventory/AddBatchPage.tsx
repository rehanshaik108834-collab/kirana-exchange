import { type FormEvent, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { AlertTriangle, Loader2, X } from 'lucide-react';
import { currentClaims } from '../../lib/session';
import { useIdempotencyKey } from '../../lib/use-idempotency-key';
import { CatalogSearch } from '../catalog/CatalogSearch';
import type { Product } from '../catalog/hooks';
import { enqueueBatch } from '../offline/runtime';
import { addDaysIso } from './expiry';

function defaultBatchCode(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `B${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`;
}

/** US-08: add a stock batch (qty, cost price, expiry) for a catalog product. */
export function AddBatchPage() {
  const navigate = useNavigate();
  const shopId = currentClaims()?.shopId ?? null;
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const idempotency = useIdempotencyKey();

  const [product, setProduct] = useState<Product | null>(null);
  const [batchCode, setBatchCode] = useState(defaultBatchCode);
  const [qty, setQty] = useState('');
  const [costPrice, setCostPrice] = useState('');
  const [expiryDate, setExpiryDate] = useState('');

  const selectProduct = (p: Product) => {
    setProduct(p);
    setExpiryDate(addDaysIso(p.shelfLifeDays));
    // A different product is a new logical submission.
    idempotency.rotate();
  };

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    if (!product || !shopId || saving) return;
    setSaving(true);
    setSaveError(null);
    try {
      // Saved to the device first, then synced with this submission's Idempotency-Key.
      // Server-side problems (e.g. a duplicate batch code) show up later as "needs attention".
      await enqueueBatch(
        {
          shopId,
          productId: product.id,
          batchCode: batchCode.trim(),
          qty: Number(qty),
          costPrice: Number(costPrice),
          expiryDate,
        },
        product.name,
        idempotency.key,
      );
      idempotency.rotate();
      navigate('/inventory');
    } catch {
      setSaveError('Could not save on this phone. Please try again.');
    } finally {
      setSaving(false);
    }
  };

  if (!shopId) {
    return (
      <p className="text-sm text-slate-700">Your shop is not linked yet. Please sign in again.</p>
    );
  }

  return (
    <section className="space-y-4">
      <h1 className="text-xl font-bold text-slate-900">Add stock</h1>

      {!product ? (
        <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
          <CatalogSearch onSelect={selectProduct} autoFocus />
        </div>
      ) : (
        <form
          onSubmit={(e) => void handleSubmit(e)}
          className="space-y-4 rounded-xl border border-slate-200 bg-white p-4 shadow-sm"
        >
          <div className="flex items-start justify-between gap-2 rounded-lg bg-teal-50 p-3">
            <div>
              <p className="font-semibold text-slate-900">{product.name}</p>
              <p className="text-xs text-slate-700">
                {product.brand} · {product.packSize} · MRP ₹{Number(product.mrp).toFixed(2)}
              </p>
            </div>
            <button
              type="button"
              onClick={() => setProduct(null)}
              aria-label="Change product"
              className="rounded-md p-1 text-slate-600 hover:bg-white"
            >
              <X className="h-4 w-4" />
            </button>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <label htmlFor="qty" className="mb-1 block text-sm font-medium text-slate-700">
                Quantity (units)
              </label>
              <input
                id="qty"
                type="number"
                inputMode="numeric"
                min={1}
                step={1}
                required
                value={qty}
                onChange={(e) => setQty(e.target.value)}
                className="w-full rounded-lg border border-slate-300 px-3 py-2.5 text-base focus:border-teal-600 focus:outline-none"
              />
            </div>
            <div>
              <label htmlFor="cost" className="mb-1 block text-sm font-medium text-slate-700">
                Cost price per unit (₹)
              </label>
              <input
                id="cost"
                type="number"
                inputMode="decimal"
                min={0}
                step="0.01"
                required
                value={costPrice}
                onChange={(e) => setCostPrice(e.target.value)}
                className="w-full rounded-lg border border-slate-300 px-3 py-2.5 text-base focus:border-teal-600 focus:outline-none"
              />
            </div>
            <div>
              <label htmlFor="expiry" className="mb-1 block text-sm font-medium text-slate-700">
                Expiry date
              </label>
              <input
                id="expiry"
                type="date"
                required
                value={expiryDate}
                onChange={(e) => setExpiryDate(e.target.value)}
                className="w-full rounded-lg border border-slate-300 px-3 py-2.5 text-base focus:border-teal-600 focus:outline-none"
              />
            </div>
            <div>
              <label htmlFor="batchCode" className="mb-1 block text-sm font-medium text-slate-700">
                Batch code
              </label>
              <input
                id="batchCode"
                type="text"
                required
                maxLength={64}
                value={batchCode}
                onChange={(e) => setBatchCode(e.target.value)}
                className="w-full rounded-lg border border-slate-300 px-3 py-2.5 text-base focus:border-teal-600 focus:outline-none"
              />
            </div>
          </div>

          {saveError && (
            <div className="flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-800">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
              <p>{saveError}</p>
            </div>
          )}

          <button
            type="submit"
            disabled={saving}
            className="inline-flex min-h-12 w-full items-center justify-center gap-2 rounded-lg bg-teal-700 px-4 text-base font-semibold text-white hover:bg-teal-800 disabled:opacity-50"
          >
            {saving && <Loader2 className="h-5 w-5 animate-spin" />}
            Save batch
          </button>
        </form>
      )}
    </section>
  );
}
