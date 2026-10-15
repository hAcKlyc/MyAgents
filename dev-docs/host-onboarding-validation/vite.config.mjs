import { mergeConfig } from 'vite';
import { resolve } from 'node:path';
import base from '../../vite.config';
export default mergeConfig(base, {
  root: resolve(import.meta.dirname),
  resolve: { alias: [{ find: '@tauri-apps/api/core', replacement: resolve(import.meta.dirname, 'mock.ts') }] },
  server: { host: '127.0.0.1', port: 5197, strictPort: true, proxy: {} },
});
