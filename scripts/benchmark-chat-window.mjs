// Production renderer, full Chat surface, synthetic Tab state, offline transports.
// Run with node scripts/benchmark-chat-window.mjs [webkit|chrome].
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { build, preview } from 'vite';
import { webkit, chromium } from 'playwright';

const repo = process.env.CHAT_BENCH_REPO ?? resolve(import.meta.dirname, '..');
const root = resolve(repo, 'src/renderer');
const reuse = process.env.CHAT_BENCH_BUILD;
const output = reuse ?? await mkdtemp(resolve(tmpdir(), 'myagents-chat-window-'));
const engine = process.argv[2] ?? 'webkit';
const pageId = resolve(root, '__chat_benchmark.html');
const entryId = resolve(root, '__chat_benchmark.tsx');
const entry = `
import React, { useContext, useState, useLayoutEffect, useMemo, useCallback, useRef } from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import Chat from './pages/Chat';
import { SessionDeletionContext } from './context/SessionDeletionContext';
import { ConfigProvider } from './config/ConfigProvider';
import { ConfiguredThemeRuntime } from './theme';
import { ToastProvider } from './components/Toast';
import { ImagePreviewProvider } from './context/ImagePreviewContext';
import { TabContext, TabApiContext, TabActiveContext } from './context/TabContext';
import {i18n} from './i18n';
import './index.css';
const count = Number(new URL(location.href).searchParams.get('count'));
const row = (id,role,content) => ({id,role,content,timestamp:new Date(0)});
const history = Array.from({length:count}, (_, i) => row('h'+i, i%2?'assistant':'user','History question '+i));
const presentation = {surfaceAvailable:true,generation:1,focused:true};
const api = async () => ({success:true, data:[], sessions:[], agents:[], files:[]});
const transport = {tabId:'fixture',apiGet:api,apiPost:api,apiPut:api,apiDelete:api};
function Fixture() {
  const defaults = useContext(TabContext);
  const [tail, setTail] = useState({...row('growing','assistant','Initial text.'),streamingTextActive:true});
  const [runState,setRunState] = useState('running');
  const [active,setActive] = useState(true);
  const [older,setOlder] = useState([]);
  const page = useRef(null);
  const historyRows = useMemo(() => older.length ? [...older,...history] : history,[older]);
  const loadOlderMessages = useCallback(async options => {
    if (!page.current || !options?.beforePrepend) return;
    const prepared = page.current;
    page.current = null;
    window.adoptedAt = performance.now();
    options.beforePrepend(prepared.length);
    setOlder(prepared);
  }, []);
  useLayoutEffect(() => {
    window.append = () => flushSync(() => setTail(prior => ({...prior,content:prior.content+'x'})));
    window.paintText = content => setTail(prior => ({...prior,content}));
    window.armPage = () => {
      window.adoptedAt = undefined;
      page.current = Array.from({length:80},(_,i)=>row('bench-older'+i,'user','Earlier message '+i));
    };
    window.resetPage = () => {page.current=null;flushSync(()=>setOlder([]))};
    window.running = () => flushSync(() => setRunState('running'));
    window.switchTab = value => flushSync(() => setActive(value));
    window.stopLabel = () => i18n.t('chat:input.stop');
    window.stoppingLabel = () => i18n.t('chat:input.stopping');
  }, []);
  return <SessionDeletionContext.Provider value={api}><TabApiContext.Provider value={transport}><TabActiveContext.Provider value={active}>
    <TabContext.Provider value={{...defaults,...transport,agentDir:'/fixture',sessionId:'fixture',
      historyMessages:historyRows,streamingMessage:tail,messages:[...historyRows,tail],firstItemIndex:1000000-older.length,
      hasMoreBefore:location.search.includes('paging'),loadOlderMessages,
      isConnected:true,isLoading:true,sessionState:runState,sessionRuntime:'builtin',
      stopResponse:async()=>{setRunState('stopping');return {success:true,alreadyStopped:false}}}}>
      <Chat windowPresentation={presentation} sidecarConfigDisposition="pending" sessionTitle="Benchmark"/>
    </TabContext.Provider></TabActiveContext.Provider></TabApiContext.Provider></SessionDeletionContext.Provider>;
}
createRoot(document.getElementById('root')).render(<ConfigProvider><ConfiguredThemeRuntime><ToastProvider>
  <ImagePreviewProvider><Fixture/></ImagePreviewProvider></ToastProvider></ConfiguredThemeRuntime></ConfigProvider>);
`;
if (!reuse) await build({
  configFile: resolve(repo, 'vite.config.ts'), logLevel: 'warn',
  build: { outDir: output, rollupOptions: { input: pageId } },
  plugins: [{ name: 'chat-window-benchmark', enforce: 'pre',
    resolveId(id) { if (id === pageId || id === entryId) return id; if (id === '/__chat_benchmark.tsx') return entryId; },
    load(id) {
      if (id === pageId) return '<!doctype html><html><body><div id="root" style="height:100vh"></div><script type="module" src="/__chat_benchmark.tsx"></script></body></html>';
      if (id === entryId) return entry;
    },
  }],
});
const server = await preview({ configFile: false, build: { outDir: output }, preview: { host: '127.0.0.1', port: 0 } });
const browser = await (engine === 'chrome' ? chromium : webkit).launch(engine === 'chrome' ? {channel:'chrome'} : {});
try {
  const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
  page.on('pageerror', error => console.error(error.message));
  const origin = 'http://127.0.0.1:' + server.httpServer.address().port;
  await page.route('**/*', route => {
    const url = new URL(route.request().url());
    if (url.origin === origin && (url.pathname.startsWith('/assets/') || url.pathname === '/__chat_benchmark.html')) return route.continue();
    return route.fulfill({contentType:'application/json', body:'{}'});
  });
  const results = [];
  for (const count of [80, 1000, 5000, 10000]) {
    await page.goto(origin + '/__chat_benchmark.html?count=' + count);
    await page.waitForSelector('[data-message-id="growing"]', { timeout: 20000 });
    await page.waitForTimeout(500); // Exclude cold startup and initial virtual-list alignment.
    const result = await page.evaluate(async () => {
      const samples = [], frames = [];
      let last = 0;
      for (let i = 0; i < 112; i++) {
        const frame = await new Promise(requestAnimationFrame);
        const start = performance.now();
        window.append();
        if (i >= 12) { samples.push(performance.now()-start); frames.push(frame-last); }
        last = frame;
      }
      const sorted = [...samples].sort((a,b)=>a-b);
      return { median:sorted[49], p95:sorted[94], max:sorted[99],
        longFrames:frames.filter(delta => delta>33).length, controls:document.querySelector('.overflow-y-auto.py-3')?.querySelectorAll('button').length ?? 0,
        samples, frames };
    });
    assert.ok(result.controls > 0);
    if (!process.env.CHAT_BENCH_REPO) assert.ok(result.controls < 100);
    results.push({count,...result});
    console.log(JSON.stringify({count, median:result.median, p95:result.p95, max:result.max, longFrames:result.longFrames, controls:result.controls}));
  }
  if (process.argv.includes('--interactions')) {
    await page.keyboard.press('Meta+f');
    const input = page.locator('[role=search] input');
    await input.waitFor();
    const response = await page.evaluate(async () => {
      const panel = document.querySelector('[role=search]');
      const input = panel.querySelector('input');
      const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      const times = [];
      const stream = setInterval(() => window.append(), 33);
      try {
        for (let i = 0; i < 105; i++) {
          const begin = performance.now();
          set.call(input, 'History question ' + (8000+i));
          input.dispatchEvent(new Event('input', {bubbles:true}));
          // Wait for the new input's own result. Query replacement first clears the old result.
          await new Promise(requestAnimationFrame);
          while (panel.querySelector('button').disabled || panel.textContent.indexOf('1 / 1') < 0) {
            if (performance.now()-begin > 1500) throw Error('Search deadline elapsed');
            await new Promise(requestAnimationFrame);
          }
          if (i>=5) times.push(performance.now()-begin);
        }
      } finally { clearInterval(stream); }
      return times.sort((a,b)=>a-b);
    });
    console.log(JSON.stringify({searchMedian:response[49],searchP95:response[94],searchMax:response[99]}));
    await writeFile(resolve(output,engine+'-search.json'),JSON.stringify(response));
  }
  if (process.argv.includes('--paging')) {
    await page.goto(origin + '/__chat_benchmark.html?count=80&paging=1');
    await page.waitForSelector('[data-message-id="growing"]');
    const values = await page.evaluate(async () => {
      const values = [];
      const frame = () => new Promise(requestAnimationFrame);
      const scroller = document.querySelector('[data-virtuoso-scroller]');
      const inViewport = row => {
        const r = row.getBoundingClientRect(), v = scroller.getBoundingClientRect();
        return r.height > 0 && r.top < v.bottom && r.bottom > v.top;
      };
      for (let i=0; i<105; i++) {
        window.resetPage();
        scroller.scrollTop = scroller.clientHeight;
        for (let j=0; j<5; j++) await frame();
        window.armPage();
        scroller.dispatchEvent(new WheelEvent('wheel',{deltaY:-180,bubbles:true}));
        const begin = performance.now();
        // Continue the reader's upward motion past the retained prepend anchor.
        // Stop at the first frame where an actual old message intersects the viewport.
        for (;;) {
          scroller.scrollTop = Math.max(0,scroller.scrollTop - scroller.clientHeight / 2);
          await frame();
          if (window.adoptedAt !== undefined &&
            [...scroller.querySelectorAll('[data-message-id^="bench-older"]')].some(inViewport)) break;
          if (performance.now()-begin>2000) throw Error('Prepared older page did not become visible');
        }
        if (i>=5) values.push(performance.now()-window.adoptedAt);
      }
      return values;
    });
    const sorted=[...values].sort((a,b)=>a-b);
    console.log(JSON.stringify({name:'page',median:sorted[49],p95:sorted[94],max:sorted[99]}));
    await writeFile(resolve(output,engine+'-paging.json'),JSON.stringify(values));
  }
  if (process.argv.includes('--feedback')) {
    await page.goto(origin + '/__chat_benchmark.html?count=10000');
    await page.waitForSelector('[data-message-id="growing"]');
    await page.waitForTimeout(500);
    const observations = await page.evaluate(async () => {
      const times = { stop: [], input: [], chunk: [], hot: [] };
      const frame = () => new Promise(requestAnimationFrame);
      const measure = async (name, act, done, iteration) => {
        const start = performance.now();
        act();
        do {
          await frame();
          if (performance.now() - start > 1500) throw Error(name + ' feedback timeout');
        } while (!done());
        if (iteration >= 5) times[name].push(performance.now() - start);
      };
      const editor = document.querySelector('[contenteditable="true"],[contenteditable="plaintext-only"],textarea');
      if (!editor) throw Error('Missing composer');
      const button = label => [...document.querySelectorAll('button[title]')].find(b => b.title === label);
      const tail = () => document.querySelector('[data-message-id="growing"]');
      for (let i = 0; i < 105; i++) {
        const prefix = 'const sample = ' + i;
        const code = String.fromCharCode(96).repeat(3) + 'ts\n' + prefix;
        await measure('chunk', () => window.paintText(code), () => tail()?.textContent.includes(prefix), i);
        editor.focus();
        await measure('input', () => document.execCommand('insertText',false,'x'), () =>
          ((editor.value ?? editor.textContent) || '').includes('x'), i);
        document.execCommand('selectAll',false);
        document.execCommand('delete',false);
        window.running();
        const stop = button(window.stopLabel());
        if (!stop) throw Error('Missing stop button');
        await measure('stop', () => stop.click(), () => button(window.stoppingLabel())?.disabled, i);
        window.switchTab(false);
        await frame();
        await measure('hot', () => window.switchTab(true), () => {
          const rect = tail()?.getBoundingClientRect();
          return !!rect && rect.bottom > 0 && rect.top < innerHeight;
        }, i);
      }
      return times;
    });
    for (const [name, raw] of Object.entries(observations)) {
      const ordered = [...raw].sort((a,b) => a-b);
      console.log(JSON.stringify({name, median:ordered[49],p95:ordered[94],max:ordered[99]}));
    }
    await writeFile(resolve(output,engine+'-feedback.json'), JSON.stringify(observations));
  }
  await writeFile(resolve(output,engine+'-measurements.json'),JSON.stringify(results));
  console.log('Raw measurements:',output);
} finally {
  await browser.close();
  await server.close();
}
