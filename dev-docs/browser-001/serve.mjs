import { createServer } from 'vite';
import { resolve } from 'node:path';
const root = resolve(import.meta.dirname, '../..');
const mock = resolve(import.meta.dirname, 'mock.ts');
const server = await createServer({ configFile: resolve(root, 'vite.config.ts'), cacheDir: '/private/tmp/moxbots-browser-vite',
  resolve: { alias: ['@/hooks/useBrowserResourceReady', '@/components/CliToolsSection'].map(find => ({ find, replacement: mock })) },
  server: { host: '127.0.0.1', port: 8897, strictPort: true },
  plugins: [{ name: 'browser-acceptance-fixture', configResolved(config) { config.server.proxy = undefined; }, configureServer(v) { v.middlewares.use(async (req, res, next) => {
    if (req.url?.split('?')[0] !== '/__browser') return next();
    res.setHeader('Content-Type', 'text/html');
    res.end(await v.transformIndexHtml(req.url, `<html><head><meta name="viewport" content="width=device-width, initial-scale=1" /></head><body style="margin:0"><div id="root"></div><script type="module" src="/@fs/${import.meta.dirname}/fixture.tsx"></script></body></html>`));
  }); } }] });
await server.listen(); console.log('http://127.0.0.1:8897/__browser');
