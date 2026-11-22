import { lazy, Suspense, useEffect, useId, useState } from 'react';
import { Barcode, Camera, Loader2, Search } from 'lucide-react';
import { isEan, type Product, useCatalogSearch } from './hooks';

// ZXing (~400 kB) loads only when the shopkeeper taps Scan.
const BarcodeScanner = lazy(() =>
  import('./BarcodeScanner').then((m) => ({ default: m.BarcodeScanner })),
);

interface CatalogSearchProps {
  onSelect: (product: Product) => void;
  autoFocus?: boolean;
}

function useDebounced<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const t = window.setTimeout(() => setDebounced(value), delayMs);
    return () => window.clearTimeout(t);
  }, [value, delayMs]);
  return debounced;
}

/** Search by partial name/brand, or type/paste a barcode (EAN). Keyboard: arrows + Enter. */
export function CatalogSearch({ onSelect, autoFocus }: CatalogSearchProps) {
  const [input, setInput] = useState('');
  const [active, setActive] = useState(0);
  const [scanning, setScanning] = useState(false);
  const query = useDebounced(input, 250);
  const search = useCatalogSearch(query);
  const results = query.trim().length >= 2 ? (search.data?.products ?? []) : [];
  const fromCache = Boolean(search.data?.fromCache);
  const listId = useId();

  useEffect(() => setActive(0), [query]);

  const choose = (product: Product) => {
    onSelect(product);
    setInput('');
  };

  return (
    <div className="space-y-2">
      <label htmlFor={`${listId}-input`} className="block text-sm font-medium text-slate-700">
        Find product (name or barcode)
      </label>
      <div className="flex gap-2">
        <div className="relative flex-1">
          {isEan(input) ? (
            <Barcode className="pointer-events-none absolute left-3 top-3 h-5 w-5 text-slate-400" />
          ) : (
            <Search className="pointer-events-none absolute left-3 top-3 h-5 w-5 text-slate-400" />
          )}
          <input
            id={`${listId}-input`}
            type="search"
            inputMode="search"
            autoComplete="off"
            autoFocus={autoFocus}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (results.length === 0) return;
              if (e.key === 'ArrowDown') {
                e.preventDefault();
                setActive((i) => Math.min(i + 1, results.length - 1));
              } else if (e.key === 'ArrowUp') {
                e.preventDefault();
                setActive((i) => Math.max(i - 1, 0));
              } else if (e.key === 'Enter') {
                e.preventDefault();
                choose(results[active]);
              }
            }}
            role="combobox"
            aria-expanded={results.length > 0}
            aria-controls={listId}
            aria-activedescendant={results.length > 0 ? `${listId}-${active}` : undefined}
            placeholder="e.g. parle g, toor dal, 8901..."
            className="w-full rounded-lg border border-slate-300 py-2.5 pl-10 pr-10 text-base focus:border-teal-600 focus:outline-none"
          />
          {search.isFetching && (
            <Loader2 className="absolute right-3 top-3 h-5 w-5 animate-spin text-slate-400" />
          )}
        </div>
        <button
          type="button"
          onClick={() => setScanning(true)}
          aria-label="Scan barcode with camera"
          className="inline-flex min-h-11 min-w-11 items-center justify-center rounded-lg border border-slate-300 bg-white text-slate-700 hover:bg-slate-50"
        >
          <Camera className="h-5 w-5" aria-hidden="true" />
        </button>
      </div>

      {scanning && (
        <Suspense fallback={null}>
          <BarcodeScanner
            onDetected={(ean) => {
              // A scanned EAN runs the exact barcode lookup (online, or the offline cache).
              setScanning(false);
              setInput(ean);
            }}
            onClose={() => setScanning(false)}
          />
        </Suspense>
      )}

      {search.error && <p className="text-sm text-red-700">{search.error.detail}</p>}

      {fromCache && query.trim().length >= 2 && (
        <p className="text-xs text-amber-900">
          Offline: showing products saved on this phone. Connect to search the full catalogue.
        </p>
      )}

      {query.trim().length >= 2 && !search.isFetching && results.length === 0 && !search.error && (
        <p className="text-sm text-slate-600">
          No product found. Try fewer words or another spelling.
        </p>
      )}

      {results.length > 0 && (
        <ul
          id={listId}
          role="listbox"
          className="max-h-72 divide-y divide-slate-100 overflow-y-auto rounded-lg border border-slate-200 bg-white"
        >
          {results.map((p, i) => (
            <li
              key={p.id}
              id={`${listId}-${i}`}
              role="option"
              aria-selected={i === active}
              onMouseEnter={() => setActive(i)}
              onClick={() => choose(p)}
              className={`cursor-pointer px-3 py-3 ${i === active ? 'bg-teal-50' : ''}`}
            >
              <p className="font-medium text-slate-900">{p.name}</p>
              <p className="text-xs text-slate-600">
                {p.brand} · {p.packSize} · MRP ₹{Number(p.mrp).toFixed(2)} · EAN {p.ean}
              </p>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
