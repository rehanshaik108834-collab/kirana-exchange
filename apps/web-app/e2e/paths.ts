import { fileURLToPath } from 'node:url';

/** apps/web-app (this package's root). */
export const WEB_APP_DIR = fileURLToPath(new URL('..', import.meta.url));

/** Fake camera frame (EAN-13 image) written by global-setup, fed to the `camera` project. */
export const CAMERA_FRAME = fileURLToPath(
  new URL('../test-results/fake-camera-ean13.mjpeg', import.meta.url),
);
