/** Pure helpers for barcode scanning (no camera / ZXing imports, so they are cheap to test and load). */

export type ScanProblem = 'insecure' | 'no-camera' | 'denied' | 'failed';

/**
 * Normalise a decoded retail barcode to the catalog's EAN form, or null if it is not one.
 * UPC-A (12 digits) is EAN-13 with a leading 0.
 */
export function normaliseScannedCode(text: string): string | null {
  const digits = text.trim();
  if (!/^\d+$/.test(digits)) return null;
  if (digits.length === 12) return `0${digits}`;
  if (digits.length === 8 || digits.length === 13) return digits;
  return null;
}

export function classifyScanError(err: unknown): ScanProblem {
  const name = err instanceof DOMException || err instanceof Error ? err.name : '';
  if (name === 'NotAllowedError' || name === 'SecurityError') return 'denied';
  if (name === 'NotFoundError' || name === 'OverconstrainedError' || name === 'NotReadableError') {
    return 'no-camera';
  }
  return 'failed';
}

/** Checks the browser can open a camera at all (needs HTTPS or localhost). */
export function cameraAvailability(): ScanProblem | null {
  if (typeof window === 'undefined' || !window.isSecureContext) return 'insecure';
  if (!navigator.mediaDevices?.getUserMedia) return 'no-camera';
  return null;
}

export const SCAN_PROBLEM_MESSAGES: Record<ScanProblem, string> = {
  insecure: 'The camera needs a secure (https) connection. Type the barcode number instead.',
  'no-camera': 'No camera was found on this device. Type the barcode number instead.',
  denied:
    'Camera permission was not given. Allow the camera in your browser settings, or type the barcode number.',
  failed: 'The camera could not start. Type the barcode number instead.',
};
