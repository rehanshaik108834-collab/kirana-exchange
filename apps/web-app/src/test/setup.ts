// Testing Library only auto-unmounts between tests when Vitest globals are enabled; do it explicitly.
import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';
import '../i18n'; // tests render English by default

afterEach(() => cleanup());
