import { render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BarcodeScanner } from './BarcodeScanner';
import { classifyScanError, normaliseScannedCode } from './scan-utils';

const engine = vi.hoisted(() => ({
  startBarcodeScanner: vi.fn(),
}));
vi.mock('./scanner-engine', () => engine);

function setCameraEnvironment({ secure, camera }: { secure: boolean; camera: boolean }) {
  Object.defineProperty(window, 'isSecureContext', { value: secure, configurable: true });
  Object.defineProperty(navigator, 'mediaDevices', {
    value: camera ? { getUserMedia: vi.fn() } : undefined,
    configurable: true,
  });
}

beforeEach(() => {
  engine.startBarcodeScanner.mockReset();
  setCameraEnvironment({ secure: true, camera: true });
});
afterEach(() => vi.restoreAllMocks());

describe('scan helpers', () => {
  it('normalises retail barcodes to catalog EANs', () => {
    expect(normaliseScannedCode('8901051000020')).toBe('8901051000020'); // EAN-13
    expect(normaliseScannedCode('96385074')).toBe('96385074'); // EAN-8
    expect(normaliseScannedCode('012345678905')).toBe('0012345678905'); // UPC-A -> EAN-13
    expect(normaliseScannedCode('https://example.com')).toBeNull(); // QR / text
    expect(normaliseScannedCode('12345')).toBeNull();
  });

  it('classifies camera failures into plain-language cases', () => {
    expect(classifyScanError(new DOMException('x', 'NotAllowedError'))).toBe('denied');
    expect(classifyScanError(new DOMException('x', 'NotFoundError'))).toBe('no-camera');
    expect(classifyScanError(new Error('boom'))).toBe('failed');
  });
});

describe('BarcodeScanner', () => {
  it('reports the scanned EAN and releases the camera on unmount', async () => {
    const stop = vi.fn();
    engine.startBarcodeScanner.mockImplementation(async (_video, onCode) => {
      setTimeout(() => onCode('8901051000020'), 0);
      return stop;
    });
    const onDetected = vi.fn();
    const { unmount } = render(<BarcodeScanner onDetected={onDetected} onClose={vi.fn()} />);
    await waitFor(() => expect(onDetected).toHaveBeenCalledWith('8901051000020'));
    unmount();
    expect(stop).toHaveBeenCalled();
  });

  it('explains a denied camera permission and offers typing instead', async () => {
    engine.startBarcodeScanner.mockRejectedValue(new DOMException('denied', 'NotAllowedError'));
    render(<BarcodeScanner onDetected={vi.fn()} onClose={vi.fn()} />);
    expect((await screen.findByRole('alert')).textContent).toMatch(/permission/i);
    expect(screen.getByRole('button', { name: 'Type the barcode instead' })).toBeTruthy();
  });

  it('never starts the camera on an insecure page', () => {
    setCameraEnvironment({ secure: false, camera: true });
    render(<BarcodeScanner onDetected={vi.fn()} onClose={vi.fn()} />);
    expect(screen.getByRole('alert').textContent).toMatch(/secure/);
    expect(engine.startBarcodeScanner).not.toHaveBeenCalled();
  });
});
