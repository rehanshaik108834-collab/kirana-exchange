import { useEffect, useRef, useState } from 'react';
import { CameraOff, X } from 'lucide-react';
import {
  cameraAvailability,
  classifyScanError,
  SCAN_PROBLEM_MESSAGES,
  type ScanProblem,
} from './scan-utils';

interface BarcodeScannerProps {
  onDetected: (ean: string) => void;
  onClose: () => void;
}

/**
 * Camera sheet for scanning a product barcode (US-06, roadmap 6.4).
 * The camera is always released on detection, on Close, and on unmount (route change).
 */
export function BarcodeScanner({ onDetected, onClose }: BarcodeScannerProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [problem, setProblem] = useState<ScanProblem | null>(() => cameraAvailability());
  const [starting, setStarting] = useState(problem === null);

  useEffect(() => {
    if (problem || !videoRef.current) return;
    let stop: (() => void) | null = null;
    let cancelled = false;
    void import('./scanner-engine')
      .then(({ startBarcodeScanner }) =>
        startBarcodeScanner(videoRef.current!, (ean) => {
          if (!cancelled) onDetected(ean);
        }),
      )
      .then((stopFn) => {
        if (cancelled) stopFn();
        else stop = stopFn;
        setStarting(false);
      })
      .catch((err) => {
        if (!cancelled) {
          setProblem(classifyScanError(err));
          setStarting(false);
        }
      });
    return () => {
      cancelled = true;
      stop?.();
    };
    // onDetected is intentionally not a dependency: restarting the camera on every render is wrong.
  }, [problem]);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Scan a barcode"
      className="fixed inset-0 z-[1200] flex flex-col bg-black/90 p-4 text-white"
    >
      <div className="flex items-center justify-between">
        <p className="font-semibold">Point the camera at the barcode</p>
        <button
          type="button"
          onClick={onClose}
          className="inline-flex min-h-11 items-center gap-1 rounded-lg bg-white/10 px-3 font-medium"
        >
          <X className="h-5 w-5" aria-hidden="true" />
          Close
        </button>
      </div>

      {problem ? (
        <div className="m-auto max-w-sm space-y-3 text-center">
          <CameraOff className="mx-auto h-10 w-10" aria-hidden="true" />
          <p role="alert">{SCAN_PROBLEM_MESSAGES[problem]}</p>
          <button
            type="button"
            onClick={onClose}
            className="min-h-12 w-full rounded-lg bg-teal-500 px-4 font-semibold text-slate-900"
          >
            Type the barcode instead
          </button>
        </div>
      ) : (
        <div className="relative mx-auto mt-6 w-full max-w-md overflow-hidden rounded-xl bg-black">
          <video
            ref={videoRef}
            className="aspect-[3/4] w-full object-cover"
            muted
            playsInline
            aria-label="Camera preview"
          />
          <div
            className="pointer-events-none absolute inset-x-8 top-1/2 h-24 -translate-y-1/2 rounded-lg border-2 border-teal-400"
            aria-hidden="true"
          />
          {starting && (
            <p className="absolute inset-x-0 bottom-3 text-center text-sm" role="status">
              Starting camera…
            </p>
          )}
        </div>
      )}
    </div>
  );
}
