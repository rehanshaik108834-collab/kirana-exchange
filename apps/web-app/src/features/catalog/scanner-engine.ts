import { BrowserMultiFormatReader } from '@zxing/browser';
import { BarcodeFormat, DecodeHintType } from '@zxing/library';
import { normaliseScannedCode } from './scan-utils';

/**
 * The only module that imports ZXing. It is reached solely through the lazily loaded
 * BarcodeScanner, so the library never weighs on the initial page load.
 *
 * Starts the back camera, decodes retail barcodes (EAN-13, EAN-8, UPC-A), and calls `onCode`
 * once with a normalised EAN. Returns `stop()`, which releases the camera.
 */
export async function startBarcodeScanner(
  video: HTMLVideoElement,
  onCode: (ean: string) => void,
): Promise<() => void> {
  const hints = new Map<DecodeHintType, unknown>([
    [
      DecodeHintType.POSSIBLE_FORMATS,
      [BarcodeFormat.EAN_13, BarcodeFormat.EAN_8, BarcodeFormat.UPC_A],
    ],
  ]);
  const reader = new BrowserMultiFormatReader(hints);
  let done = false;
  const controls = await reader.decodeFromConstraints(
    { video: { facingMode: { ideal: 'environment' } }, audio: false },
    video,
    (result, _error, ctrl) => {
      if (done || !result) return; // no code in this frame: keep scanning
      const ean = normaliseScannedCode(result.getText());
      if (!ean) return;
      done = true;
      ctrl.stop();
      onCode(ean);
    },
  );
  return () => {
    done = true;
    controls.stop();
  };
}
