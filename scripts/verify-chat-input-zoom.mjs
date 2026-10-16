// Offline layout regression using the real composer and application shortcuts.
// Run: node scripts/verify-chat-input-zoom.mjs webkit (or chromium).
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { createServer } from 'vite';
import { chromium, webkit } from 'playwright';

const repo = resolve(import.meta.dirname, '..');
const output = await mkdtemp(resolve(tmpdir(), 'moxbots-composer-zoom-'));
const engine = process.argv[2] ?? 'webkit';
assert.ok(['webkit', 'chromium'].includes(engine));
const entryId = resolve(repo, 'src/renderer/__composer_zoom_audit.tsx');
const entry = `import React,{useState} from 'react';
import {createRoot} from 'react-dom/client';
import {i18n} from './i18n';
import {ThemeRuntimeProvider} from './theme/ThemeRuntime';
import {ToastProvider} from './components/Toast';
import {ImagePreviewProvider} from './context/ImagePreviewContext';
import {ConfigDataContext} from './config/ConfigProvider';
import {DEFAULT_CONFIG} from './config/types';
import SimpleChatInput from './components/SimpleChatInput';
import {dispatchAppShortcut} from './utils/appShortcuts';
import {initializeAppZoom,changeAppZoom} from './utils/appZoom';
import './index.css';
await i18n.changeLanguage('zh-CN');
initializeAppZoom();
const noop=()=>{};
window.addEventListener('keydown',e=>dispatchAppShortcut(e,navigator.platform.toLowerCase().includes('mac'),{
 tabs:[],activeTabId:null,setActiveTabId:noop,newTab:noop,closeCurrentTab:noop,
 dismissTopmost:()=>false,hasBlockingBackdrop:()=>false,openTaskCenter:noop,openSettings:noop,changeZoom:changeAppZoom
}),{capture:true});
const long='https://example.invalid/'+('long-path-without-spaces'.repeat(60));
const samples={empty:'',loading:'',url:long,multiline:Array.from({length:45},(_,i)=>'第'+i+'行：多行文字保持可编辑').join('\\n'),suggestion:''};
function Fixture(){
 const [kind,setKind]=useState('empty');
 return <main style={{height:'var(--app-viewport-height,100vh)',position:'relative',overflow:'hidden'}}>
 <header style={{padding:12}}>输入框缩放回归（合成数据） <select aria-label="输入场景" value={kind} onChange={e=>setKind(e.target.value)}>{Object.keys(samples).map(k=><option key={k}>{k}</option>)}</select></header>
 <SimpleChatInput key={kind} value={samples[kind]} isLoading={kind==='loading'} onSend={()=>false} onStop={noop}
 runtime="builtin" providerAvailable sessionId="zoom-layout-fixture"
 nextPromptSuggestion={kind==='suggestion'?{key:'fixture',sessionId:'zoom-layout-fixture',text:'建议文字 '+long}:undefined}/>
 </main>;
}
createRoot(document.getElementById('root')).render(<ThemeRuntimeProvider selection={null}>
 <ConfigDataContext.Provider value={{config:DEFAULT_CONFIG,projects:[],providers:[],apiKeys:{},providerVerifyStatus:{},isLoading:false,error:null,managedCodexRuntimeUpdateInFlight:false}}><ToastProvider><ImagePreviewProvider><Fixture/></ImagePreviewProvider></ToastProvider></ConfigDataContext.Provider>
 </ThemeRuntimeProvider>);`;
const server = await createServer({
  configFile: resolve(repo, 'vite.config.ts'),
  cacheDir: resolve(output, 'vite-cache'),
  optimizeDeps: { exclude: ['chartjs-umd-source', 'd3-umd-source', 'lucide-umd-source', 'chartjs-umd-source?raw', 'd3-umd-source?raw', 'lucide-umd-source?raw'] },
  server: { host: '127.0.0.1', port: 0 },
  plugins: [{
    name: 'composer-zoom-fixture', enforce: 'pre',
    resolveId(id) { if (id === '/__composer_zoom_audit.tsx') return entryId; },
    load(id) { if (id === entryId) return entry; },
    configureServer(vite) {
      vite.middlewares.use(async (req, res, next) => {
        if (req.url !== '/__composer_zoom_audit') return next();
        res.setHeader('Content-Type', 'text/html');
        res.end(await vite.transformIndexHtml(req.url, '<html><body><div id="root"></div><script type="module" src="/__composer_zoom_audit.tsx"></script></body></html>'));
      });
    },
  }],
});
let browser;
const evidence = [];
try {
  await server.listen();
  browser = await (engine === 'webkit' ? webkit : chromium).launch({
    headless: true,
    ...(process.env.MOXBOTS_ZOOM_TEST_BROWSER ? { executablePath: process.env.MOXBOTS_ZOOM_TEST_BROWSER } : {}),
  });
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', error => { errors.push(error.message); console.error(error.message); });
  await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/__composer_zoom_audit`, { waitUntil: 'commit' });
  const input = page.getByRole('textbox');
  await input.waitFor({ timeout: 60_000 });
  for (const width of [844, 520]) {
    await page.setViewportSize({ width, height: 600 });
    for (const [level, key, count] of [[0.75, 'Control+-', 3], [1, '', 0], [1.1, 'Control+=', 1], [1.25, 'Control+=', 2], [1.5, 'Control+=', 3], [2, 'Control+=', 5]]) {
      await input.press('Control+0');
      for (let i = 0; i < count; i++) await input.press(key);
      for (const kind of ['empty', 'loading', 'url', 'multiline', 'suggestion']) {
        await page.getByRole('combobox', { name: '输入场景' }).selectOption(kind);
        await page.waitForFunction(() => document.querySelector('textarea')?.getBoundingClientRect().height > 0);
        const metrics = await input.evaluate(el => {
          const style = getComputedStyle(el);
          const bounds = el.getBoundingClientRect();
          const main = document.querySelector('main');
          return { zoom: Number(document.documentElement.style.zoom || 1), overflowX: style.overflowX, overflowY: style.overflowY,
            width: el.clientWidth, scrollWidth: el.scrollWidth, scrollHeight: el.scrollHeight, height: el.clientHeight,
            fits: bounds.left >= 0 && bounds.right <= main.getBoundingClientRect().right + 1,
            pageOverflow: main.scrollWidth > main.clientWidth + 1, value: el.value };
        });
        evidence.push({ viewportWidth: width, level, kind, ...metrics, value: undefined });
        assert.equal(metrics.zoom, level);
        assert.equal(metrics.overflowX, 'hidden', JSON.stringify(evidence.at(-1)));
        assert.equal(metrics.overflowY, 'auto');
        // WebKit mixes painted scrollWidth and layout clientWidth after CSS
        // zoom even for an empty textarea. Verify painted containment and real
        // wheel behavior instead of treating those unequal units as overflow.
        assert.ok(metrics.fits, JSON.stringify(evidence.at(-1)));
        assert.equal(metrics.pageOverflow, false);
        const bounds = await input.boundingBox();
        await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
        await page.mouse.wheel(100, 0);
        await page.waitForTimeout(50);
        assert.equal(await input.evaluate(el => el.scrollLeft), 0, 'horizontal wheel must not pan wrapped input');
        if (kind === 'suggestion') assert.equal(await page.getByTestId('next-prompt-ghost').evaluate(el => el.scrollLeft), 0);
        if (kind === 'multiline') {
          assert.ok(metrics.scrollHeight > metrics.height, 'long drafts must keep vertical scrolling');
          await input.evaluate(el => { el.scrollTop = el.scrollHeight; });
          assert.ok(await input.evaluate(el => el.scrollTop > 0));
        }
        if (kind === 'url') {
          assert.equal(metrics.value, 'https://example.invalid/' + 'long-path-without-spaces'.repeat(60));
          assert.ok(metrics.scrollHeight > 52, 'long URLs must wrap onto multiple lines rather than get clipped');
        }
        if (kind === 'empty' && level === 1.25 && width === 844) await page.screenshot({ path: resolve(output, `${engine}-125-empty.png`) });
      }
    }
  }
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ engine, version: browser.version(), status: 'PASS', cases: evidence.length, output }));
} finally {
  await writeFile(resolve(output, 'metrics.json'), JSON.stringify(evidence, null, 2));
  await browser?.close();
  await server.close();
}
