// Offline regression using real Message/Markdown, controller, CSS and Virtuoso.
// Usage: npm run verify:chat-scroll -- webkit (or chrome / chromium).
// --follow-only runs motion/reading checks independently of the history seed audit.
// Videos and geometry evidence are retained in the printed temporary directory.
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { createServer } from 'vite';
import { chromium, webkit } from 'playwright';
import { verifyScrollOwnership } from './chat-scroll-ownership-cases.mjs';
import { patchReactVirtuoso } from './patch-react-virtuoso.mjs';

const repo = resolve(import.meta.dirname, '..');
patchReactVirtuoso(resolve(repo, 'node_modules/react-virtuoso'), true);
const output = await mkdtemp(resolve(tmpdir(), 'myagents-scroll-verification-'));
const engine = process.argv[2] ?? 'webkit';
const readingOnly = process.argv.includes('--reading-only');
const ownershipOnly = process.argv.includes('--ownership-only');
const followOnly = process.argv.includes('--follow-only');
assert.ok(['webkit', 'chrome', 'chromium'].includes(engine), 'Choose webkit, chrome or chromium');
const entryId = repo + '/src/renderer/__scroll_audit.tsx';
const entry=`import React,{useState,useRef,useLayoutEffect} from 'react';
import {createRoot} from 'react-dom/client';
import {i18n} from './i18n';
import {ThemeRuntimeProvider} from './theme/ThemeRuntime';
import './index.css';
import MessageList from './components/MessageList';
import {ImagePreviewProvider} from './context/ImagePreviewContext';
import {useChatScrollModel} from './hooks/useChatScrollModel';
import {useChatScrollController} from './hooks/useChatScrollController';
import {useChatSearch} from './hooks/useChatSearch';
import {readingAnchorDelta} from './utils/chatReadingAnchor';
await i18n.changeLanguage('zh-CN');
const mk=(id,content,role='assistant')=>({id,content,role,timestamp:new Date(),streamingTextActive:true});
const seedMode=new URLSearchParams(location.search).get('seed');
const nl=String.fromCharCode(10),fence=String.fromCharCode(96).repeat(3);
const mixedHistory=Array.from({length:300},(_,i)=>mk('h'+i,i%20!==1?'Short user message '+i:[
 '## Report '+i,'| Column A | Column B |','| --- | --- |',
 Array(40).fill('| cell | table content |').join(nl),fence+'typescript',
 Array(60).fill('const value = 123;').join(nl),fence,
].join(nl),i%20!==1?'user':'assistant'));
const history=seedMode?mixedHistory:Array.from({length:25},(_,i)=>mk('h'+i,('History paragraph '+i+' with stable lines. ').repeat(15)));
function Fixture(){
 const [active,setActive]=useState(true);
 const [session,setSession]=useState('audit');
 const [loaded,setLoaded]=useState(seedMode!=='deferred');
 const [sm,setSm]=useState(mk('stream','Streaming start.'));
 const [loading,setLoading]=useState(true);
 const [permission,setPermission]=useState(false);
 const [searchOpen,setSearchOpen]=useState(false);
 const [height,setHeight]=useState(640);
 const [spacer,setSpacer]=useState(176);
 const rootRef=useRef(null);
 const model=useChatScrollModel({historyMessages:loaded?history:[],streamingMessage:loaded?sm:null,sessionId:session});
 const ctrl=useChatScrollController({messages:model.data,isActive:active,sessionId:session,rootRef});
 const search=useChatSearch({active:searchOpen,messages:model.data,scrollerRef:ctrl.scrollerRef,scrollToMessage:ctrl.scrollToMessage,pauseAutoScroll:ctrl.pauseAutoScroll});
 useLayoutEffect(()=>{window.audit={ctrl,search,readingAnchorDelta,setActive,setSession,setLoaded,load:()=>setLoaded(true),seed:model.heightEstimateSeed,
 readState:()=>new Promise(resolve=>ctrl.virtuosoRef.current.getState(resolve)),setSearchOpen,setLoading,setHeight,setSpacer,setPermission,
 showDisclosure:()=>setSm(prev=>({...prev,content:[{type:'thinking',thinking:'Expanded thinking content with many lines. '.repeat(100),isComplete:true},{type:'text',text:'Disclosure tail.'}]})),
 growDisclosure:()=>setSm(prev=>({...prev,content:prev.content.map(block=>block.type==='text'?{...block,text:block.text+' Later output below the open content. '.repeat(20)}:block)})),append:text=>setSm(prev=>({...prev,content:prev.content+text})),replace:text=>setSm(prev=>({...prev,content:text})),snapshot:()=>{
  const el=ctrl.scrollerRef.current; const status=document.querySelector('[data-chat-status-row]');
  const er=el?.getBoundingClientRect();
  const rows=[...document.querySelectorAll('[data-message-id]')];
  const anchor=rows.find(row=>row.getBoundingClientRect().bottom>(er?.top??0));
  return {top:el?.scrollTop,height:el?.scrollHeight,viewport:el?.clientHeight,gap:el?el.scrollHeight-el.scrollTop-el.clientHeight:null,follow:ctrl.followEnabledRef.current,statusY:status?.getBoundingClientRect().top,statusH:status?.getBoundingClientRect().height,anchor:anchor?.dataset.messageId,anchorY:anchor?anchor.getBoundingClientRect().top-er.top:null};
 }}});
 return <div ref={rootRef} style={{height,width:760,display:'flex',flexDirection:'column',position:'relative',overflow:'hidden'}}>
 <MessageList firstItemIndex={100000} messages={model.data} streamingMessage={loaded?sm:null} isLoading={loading} sessionState={loading?'running':'idle'} isStreaming={loading} sessionId={session} isActive={active}
 heightEstimateSeed={model.heightEstimateSeed} layoutByMessageId={model.layoutByMessageId} virtuosoRef={ctrl.virtuosoRef}
 onScrollerRef={ctrl.attachScroller} followEnabledRef={ctrl.followEnabledRef} scrollToBottom={ctrl.scrollToBottom} handleAtBottomChange={ctrl.handleAtBottomChange}
 onViewportAdmissionChanged={ctrl.onViewportAdmissionChanged} onItemsRendered={ctrl.onItemsRendered} isViewportRecoveryFenced={ctrl.isViewportRecoveryFenced}
 onRowLayoutChanged={ctrl.onRowLayoutChanged} bottomSpacerPx={spacer}
 pendingPermission={permission?{requestId:'fixture-permission',toolName:'Bash',input:'{"command":"pwd"}'}:null}
 onPermissionDecision={()=>setPermission(false)} />
 </div>;
}
createRoot(document.getElementById('root')).render(<ThemeRuntimeProvider selection={null}><ImagePreviewProvider><Fixture/></ImagePreviewProvider></ThemeRuntimeProvider>);`;
const server = await createServer({
  configFile: resolve(repo, 'vite.config.ts'),
  cacheDir: resolve(output, 'vite-cache'),
  optimizeDeps: { exclude: [
    'chartjs-umd-source', 'd3-umd-source', 'lucide-umd-source',
    'chartjs-umd-source?raw', 'd3-umd-source?raw', 'lucide-umd-source?raw',
  ] },
  server: { host: '127.0.0.1', port: 0 },
  plugins: [{
    name: 'chat-scroll-fixture', enforce: 'pre',
    resolveId(id) { if (id === '/__scroll_audit.tsx') return entryId; },
    load(id) { if (id === entryId) return entry; },
    configureServer(vite) {
      vite.middlewares.use(async (req, res, next) => {
        if (req.url?.split('?')[0] !== '/__scroll_audit') return next();
        res.setHeader('Content-Type', 'text/html');
        res.end(await vite.transformIndexHtml(req.url, '<html><head><style>:root{--font-body:Arial,sans-serif;--font-code:monospace;--paper:white;--ink:black;--ink-muted:#666}body{margin:0}[data-chat-status-row]{outline:2px solid rgb(255,0,255)}</style></head><body><div id="root"></div><script type="module" src="/__scroll_audit.tsx"></script></body></html>'));
      });
    },
  }],
});
let browser;
let page;
const deadline = setTimeout(() => void browser?.close(), 120000);
try {
  await server.listen();
  browser = await (engine === 'webkit' ? webkit : chromium).launch({
    headless: true, ignoreDefaultArgs: ['--hide-scrollbars'], ...(engine === 'chrome' ? { channel: 'chrome' } : {}),
  });
  page = await browser.newPage({ viewport: { width: 1000, height: 800 },
    recordVideo: { dir: output, size: { width: 1000, height: 800 } } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const address = server.httpServer.address();
  const fixtureUrl = `http://127.0.0.1:${address.port}/__scroll_audit`;
  if (readingOnly) {
    await page.goto(fixtureUrl);
    await page.waitForFunction(() => window.audit?.ctrl.scrollerRef.current);
    await page.evaluate(() => {
      const lines = Array.from({length:140}, (_, i) => 'Paragraph ' + i + '. ' + ('Reading this section in the same position. ').repeat(5));
      window.audit.replace(lines.join('\n\n'));
      window.audit.ctrl.scrollToBottom('auto');
    });
    await page.waitForFunction(() => document.querySelectorAll('[data-message-id="stream"] p').length > 100);
    await page.waitForTimeout(400);
    await page.mouse.move(360,280);
    await page.mouse.wheel(0,-1800);
    await page.waitForTimeout(350);
    const origin = await page.evaluate(() => {
      const anchor = window.audit.ctrl.captureAnchor('test');
      if (!anchor?.reading) throw Error('No internal text position at the reading line');
      window.reading = anchor.reading;
      return {source:anchor.reading.source, top:anchor.reading.top};
    });
    const offsets = [];
    for (const width of [525, 740, 580, 760]) {
      await page.evaluate(width => { document.querySelector('[data-viewport-phase]').parentElement.style.width = width + 'px'; }, width);
      await page.waitForTimeout(250);
      offsets.push(await page.evaluate(() => {
        const anchor = window.reading;
        const node = anchor.node.deref();
        const range = document.createRange();
        range.setStart(node, anchor.offset);
        range.setEnd(node, anchor.offset+1);
        return range.getBoundingClientRect().top-window.audit.ctrl.scrollerRef.current.getBoundingClientRect().top-anchor.top;
      }));
    }
    // Emulate an image decoding above the reading line while the same row remains mounted.
    await page.evaluate(() => {
      const img = document.createElement('img');
      img.alt = '';
      img.style.cssText = 'display:block;width:30px;height:93px';
      document.querySelector('[data-message-id="stream"] p').prepend(img);
    });
    await page.waitForTimeout(250);
    const afterImage = await page.evaluate(() => window.audit.readingAnchorDelta(
      document.querySelector('[data-message-id="stream"]'),window.reading,
      window.audit.ctrl.scrollerRef.current.getBoundingClientRect().top));
    assert.ok(afterImage != null && Math.abs(afterImage) <= 1, 'Late image moved the reading point '+afterImage);
    await page.evaluate(() => {
      const fence = String.fromCharCode(96).repeat(3);
      const longCode = Array.from({length:250}, (_,i) => '  const variable'+i+' = "a long, readable string value for this row";');
      window.audit.replace([fence+'typescript',...longCode,fence].join('\n'));
      window.audit.ctrl.scrollToBottom('auto');
    });
    await page.waitForFunction(() => document.querySelectorAll('[data-message-id="stream"] .react-syntax-highlighter-line-number').length >= 250);
    await page.waitForTimeout(250);
    await page.mouse.wheel(0,-1600);
    await page.waitForTimeout(300);
    const remounted = await page.evaluate(() => {
      const anchor = window.audit.ctrl.captureAnchor('code-remount')?.reading;
      if (!anchor?.codeLine || !anchor.source) throw Error('Expected an internal numbered code line');
      const row = document.querySelector('[data-message-id="stream"]');
      const clone = row.cloneNode(true);
      const rect = row.getBoundingClientRect();
      clone.style.cssText = 'position:fixed;left:'+rect.left+'px;top:'+rect.top+'px;width:'+rect.width+'px;visibility:hidden';
      document.body.appendChild(clone);
      try {
        const diff = window.audit.readingAnchorDelta(clone,anchor,window.audit.ctrl.scrollerRef.current.getBoundingClientRect().top);
        return {line:anchor.codeLine.number,diff};
      } finally {clone.remove();}
    });
    assert.ok(remounted.diff != null && Math.abs(remounted.diff)<=1,'Remounted code line moved '+JSON.stringify(remounted));
    console.log(JSON.stringify({engine,origin,offsets,afterImage,remounted}));
    await writeFile(resolve(output,'reading.json'),JSON.stringify({origin,offsets,afterImage,remounted}));
    assert.ok(offsets.every(d => Math.abs(d) <= 1), 'Reading position moved after reflow: '+offsets);
  } else await verifyScrollOwnership(page, fixtureUrl, output);
  if (!ownershipOnly && !readingOnly) {
  const seedEvidence = {};
  for (const mode of followOnly ? [] : ['immediate', 'deferred']) {
    await page.goto(`${fixtureUrl}?seed=${mode}`);
    await page.waitForFunction(() => window.audit?.ctrl.scrollerRef.current);
    if (mode === 'deferred') {
      // Let the empty list commit before history arrives, as on session restore.
      await page.waitForTimeout(100);
      await page.evaluate(() => window.audit.load());
    }
    await page.waitForFunction(() => document.querySelector('[data-message-id="stream"]'));
    await page.waitForTimeout(300);
    // Mounting the tail once is insufficient: a range replacement can clamp
    // WebKit's scrollTop and unmount it again without changing final list height.
    const settled = await page.evaluate(async () => {
      const frames = [];
      for (let i = 0; i < 20; i++) {
        await new Promise(requestAnimationFrame);
        frames.push(window.audit.snapshot());
      }
      return frames;
    });
    assert.ok(settled.every(s => Math.abs(s.gap) <= 1), `${mode}: initial range did not settle at bottom`);
    assert.ok(settled.every(s => s.height === settled[0].height), `${mode}: idle range kept oscillating`);
    const seeded = await page.evaluate(async () => ({
      state: await window.audit.readState(), seed: window.audit.seed,
      mounted: [...document.querySelectorAll('[data-index]')].map(el => Number(el.dataset.index)),
    }));
    // Unmeasured short and tall rows must still hold their distinct content seeds.
    for (const unmeasuredIndex of [150, 161]) {
      assert.ok(!seeded.mounted.includes(unmeasuredIndex), `${mode}: probe row was mounted`);
      const range = seeded.state.ranges.find(r => r.startIndex <= unmeasuredIndex && r.endIndex >= unmeasuredIndex);
      assert.equal(range?.size, seeded.seed[unmeasuredIndex], `${mode}: per-row seed was ignored`);
    }
    seedEvidence[mode] = { ...seeded, settled };
  }
  await writeFile(resolve(output, 'height-seeds.json'), JSON.stringify(seedEvidence, null, 2));
  await page.goto(fixtureUrl);
  await page.waitForFunction(() => window.audit?.ctrl.scrollerRef.current);
  await page.waitForTimeout(1500);
  const snapshot = () => page.evaluate(() => window.audit.snapshot());
  const evidence = {};
  const bottom = async label => {
    // Disclosure/permission transitions may finish near the end of a fixed
    // delay; await actual bounded convergence before taking settled evidence.
    await page.waitForFunction(() => Math.abs(window.audit.snapshot().gap) <= 1, null, { timeout: 2000 });
    const state = evidence[label] = await snapshot();
    assert.ok(Math.abs(state.gap) <= 1, `${label}: ${JSON.stringify(state)}`);
    assert.notEqual(state.follow, false, `${label}: follow was disabled`);
    return state;
  };
  const geometry = async label => {
    const measured = await page.evaluate(() => {
      const list = document.querySelector('[data-testid="virtuoso-item-list"]');
      const footer = list.nextElementSibling;
      const viewport = list.parentElement;
      const extent = viewport.querySelector('[data-virtuoso-scroll-extent]');
      return {
        rows: [...list.children].map(row => ({
          index: Number(row.dataset.index), known: Number(row.dataset.knownSize),
          actual: row.getBoundingClientRect().height,
        })),
        footerHeight: footer.getBoundingClientRect().height,
        naturalEnd: footer.getBoundingClientRect().bottom - viewport.getBoundingClientRect().top,
        projectedEnd: extent.getBoundingClientRect().height,
        scrollHeight: window.audit.ctrl.scrollerRef.current.scrollHeight,
        endPadding: parseFloat(list.style.paddingBottom),
      };
    });
    assert.ok(measured.rows.some(row => !Number.isInteger(row.actual)), `${label}: fractional fixture lost coverage`);
    for (const row of measured.rows) {
      assert.equal(row.known, row.actual, `${label}: row ${row.index} lost measurement precision`);
    }
    assert.equal(measured.naturalEnd, measured.projectedEnd, `${label}: model and natural layout disagree`);
    assert.equal(measured.naturalEnd, measured.scrollHeight, `${label}: native extent disagrees`);
    assert.ok(measured.endPadding >= 0 && measured.endPadding < 1, `${label}: tail padding accumulated`);
    evidence[`${label}Geometry`] = measured;
    return measured;
  };
  const sameAnchor = (before, after, label) => {
    assert.equal(after.follow, false, `${label}: reading was overridden`);
    assert.equal(after.anchor, before.anchor, `${label}: anchor changed`);
    assert.ok(Math.abs(after.anchorY - before.anchorY) <= 1, `${label}: anchor moved`);
  };
  const append = text => page.evaluate(text => window.audit.append(text), text);
  await page.evaluate(() => {
    window.samples = [];
    window.phase = 'stream';
    window.record = true;
    function frame() {
      if (!window.record) return;
      window.samples.push({ phase: window.phase, t: performance.now(), ...window.audit.snapshot() });
      requestAnimationFrame(frame);
    }
    frame();
    window.audit.ctrl.scrollToBottom('auto');
  });
  await page.waitForTimeout(400);
  const initial = await bottom('initial');
  await geometry('initial');
  const status = await page.locator('[data-chat-status-row]').elementHandle();
  for (let i = 0; i < 80; i++) {
    await append(` New content ${i} grows while loading stays true.`);
    await page.waitForTimeout(24);
  }
  await page.waitForTimeout(300);
  const streamed = await bottom('streamed');
  await geometry('streamed');
  assert.equal(streamed.statusY, initial.statusY);
  assert.ok(await status.evaluate(el => el === document.querySelector('[data-chat-status-row]')));

  // One bounded burst must move through several painted frames, not jump by a line.
  await page.evaluate(() => { window.phase = 'smooth-burst'; });
  const motion = evidence.motion = await page.evaluate(async () => {
    const before = window.audit.snapshot();
    window.audit.append('\n\n' + Array(7).fill('Smooth follow probe line.').join('\n'));
    const frames = [];
    const start = performance.now();
    while (performance.now() - start < 450) {
      await new Promise(requestAnimationFrame);
      frames.push(window.audit.snapshot());
    }
    return { before, frames };
  });
  const end = await bottom('burstSettled');
  const intermediates = motion.frames.filter(s => s.top > motion.before.top + 1 && s.top < end.top - 1);
  assert.ok(new Set(intermediates.map(s => s.top)).size >= 4, 'burst did not animate through intermediate positions');
  let previousTop = motion.before.top;
  for (const frame of motion.frames) {
    assert.ok(frame.top >= previousTop - 1, 'follow bounced backwards');
    assert.ok(frame.top - previousTop < (end.top - motion.before.top) * 0.65, 'follow jumped most of the growth in one frame');
    previousTop = frame.top;
  }
  await page.screenshot({ path: resolve(output, 'smooth-follow.png') });

  await page.evaluate(async () => {
    window.phase = 'rapid';
    for (let i = 0; i < 50; i++) {
      window.audit.append('\nRapid continuous output line ' + i + '.');
      await new Promise(requestAnimationFrame);
    }
  });
  await page.waitForTimeout(350);
  await bottom('rapidSettled');
  const rapid = await page.evaluate(() => window.samples.filter(s => s.phase === 'rapid'));
  assert.ok(rapid.every(s => s.gap < s.viewport), 'rapid output left latest content a screen behind');

  // User input cancels an actively running custom follow, not just a settled pin.
  await append('\n\n' + Array(7).fill('Cancel active follow line.').join('\n'));
  await page.waitForFunction(() => window.audit.snapshot().gap > 10);
  await page.mouse.move(360, 260);
  await page.mouse.wheel(0, -60);
  await page.waitForTimeout(100);
  const interrupted = await snapshot();
  await page.waitForTimeout(350);
  sameAnchor(interrupted, evidence.motionCancelled = await snapshot(), 'cancelled active follow');

  await page.evaluate(() => window.audit.ctrl.scrollToBottom('auto'));
  await page.waitForTimeout(1600);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await append('\n\n' + Array(7).fill('Reduced motion line.').join('\n'));
  await page.waitForTimeout(80);
  await bottom('reducedMotion');
  await page.emulateMedia({ reducedMotion: 'no-preference' });

  await page.evaluate(() => { window.phase = 'reading'; });
  await page.mouse.move(360, 260);
  await page.mouse.wheel(0, -360);
  await page.waitForTimeout(300);
  const reader = await snapshot();
  for (let i = 0; i < 35; i++) {
    await append(` Background addition ${i} stays below.`);
    await page.waitForTimeout(30);
  }
  await page.waitForTimeout(300);
  sameAnchor(reader, evidence.reading = await snapshot(), 'background streaming');
  await page.evaluate(() => { window.audit.setHeight(520); window.audit.setSpacer(260); });
  await page.waitForTimeout(300);
  sameAnchor(reader, evidence.readingResize = await snapshot(), 'reading resize');

  await page.evaluate(() => { window.phase = 'near-bottom'; window.audit.ctrl.scrollToBottom('auto'); });
  await page.waitForTimeout(1600);
  await page.mouse.wheel(0, -20);
  await page.waitForTimeout(150);
  const near = await snapshot();
  await append('\n\n' + 'Large growth near the bottom. '.repeat(50));
  await page.waitForTimeout(400);
  sameAnchor(near, evidence.near = await snapshot(), '20px upward scroll');

  // Return by user input, not by an explicit programmatic follow reset.
  await page.mouse.wheel(0, 1500);
  await page.waitForTimeout(500);
  await bottom('manualReturn');
  await page.evaluate(() => { window.phase = 'footer'; window.audit.setSpacer(300); });
  await page.waitForTimeout(300);
  await bottom('composerGrowth');
  await page.evaluate(() => window.audit.setPermission(true));
  await page.waitForTimeout(300);
  await bottom('permissionGrowth');
  await page.evaluate(() => { window.audit.setPermission(false); window.audit.setHeight(440); });
  await page.waitForTimeout(300);
  await bottom('viewportShrink');

  // A newly requested index jump still has live library retry subscriptions.
  await page.evaluate(() => { window.phase = 'immediate-cancel'; window.audit.ctrl.scrollToBottom('auto'); });
  await page.mouse.wheel(0, -100);
  await page.waitForTimeout(60);
  const immediate = await snapshot();
  await append(' Immediate growth after cancelled jump. '.repeat(15));
  await page.waitForTimeout(1500);
  sameAnchor(immediate, evidence.immediateCancel = await snapshot(), 'cancelled bottom jump');

  await page.evaluate(() => window.audit.ctrl.scrollToBottom('auto'));
  await page.waitForTimeout(1600);
  await page.evaluate(() => { window.phase = 'navigation'; window.audit.ctrl.scrollToMessage('h20', { behavior: 'smooth' }); });
  await page.waitForTimeout(120);
  await page.mouse.wheel(0, -100);
  await page.waitForTimeout(100);
  const navigation = await snapshot();
  await append(' New text while reading a search destination. '.repeat(15));
  await page.waitForTimeout(2300);
  sameAnchor(navigation, evidence.navigation = await snapshot(), 'cancelled search navigation');

  await page.evaluate(() => window.audit.ctrl.scrollToMessage('h10', { behavior: 'smooth' }));
  await page.waitForTimeout(120);
  await page.mouse.wheel(0, 100);
  await page.waitForTimeout(100);
  const downward = await snapshot();
  await append(' Later text after downward input. '.repeat(15));
  await page.waitForTimeout(1500);
  sameAnchor(downward, evidence.downwardCancel = await snapshot(), 'downward input cancels navigation');

  await page.evaluate(() => window.audit.ctrl.scrollToBottom('auto'));
  await page.waitForTimeout(1600);
  await page.evaluate(() => { window.phase = 'terminal'; window.audit.setLoading(false); });
  await page.waitForTimeout(100);
  const terminal = await bottom('terminal');
  await page.waitForTimeout(450);
  assert.equal((await snapshot()).height, terminal.height, 'late actions changed terminal height');
  assert.equal(await page.locator('[data-chat-status-row]').count(), 0);
  // Real search fast path: the entire tall streaming row is already mounted.
  await page.evaluate(() => { window.phase = 'mounted-search'; window.audit.setSearchOpen(true); window.audit.setLoading(true); window.audit.search.setQuery('Streaming start.'); });
  await page.waitForFunction(() => window.audit.search.matchCount === 1);
  await page.evaluate(() => window.audit.search.next());
  await page.waitForTimeout(400);
  const mountedSearch = await snapshot();
  assert.equal(mountedSearch.follow, false, 'mounted search did not pause');
  assert.ok(mountedSearch.gap > 50, 'search did not move to the earlier match');
  await append(' More output while reading the mounted search result. '.repeat(20));
  await page.waitForTimeout(400);
  sameAnchor(mountedSearch, evidence.mountedSearch = await snapshot(), 'mounted search reading');

  // A disclosure click is a reading decision, unlike an automatic size change.
  await page.evaluate(() => {
    window.phase = 'disclosure';
    window.audit.setHeight(640);
    window.audit.setSpacer(176);
    window.audit.setSearchOpen(false);
    window.audit.setLoading(false);
    window.audit.showDisclosure();
    window.audit.ctrl.scrollToBottom('auto');
  });
  await page.waitForTimeout(1600);
  const disclosure = page.locator('[data-message-id="stream"] [aria-expanded="false"]').first();
  const header = await disclosure.elementHandle();
  const headerY = (await header.boundingBox()).y;
  await disclosure.click();
  await page.waitForTimeout(400);
  assert.equal((await snapshot()).follow, false, 'disclosure click did not enter reading');
  assert.ok(Math.abs((await header.boundingBox()).y - headerY) <= 1, 'expanded header moved');
  await page.evaluate(() => { window.audit.setLoading(true); window.audit.growDisclosure(); });
  await page.waitForTimeout(350);
  assert.ok(Math.abs((await header.boundingBox()).y - headerY) <= 1, 'new output moved the disclosure reader');
  evidence.disclosure = await snapshot();

  // The virtual scroll extent must not constrain the measured list. Otherwise
  // shrinking content stops triggering ResizeObserver and leaves a blank tail.
  await page.evaluate(() => {
    window.audit.setLoading(false);
    window.audit.ctrl.scrollToBottom('auto');
    window.audit.replace(Array(250).fill('Tall tail before shrink.').join('\n\n'));
  });
  await page.waitForTimeout(500);
  const grownTail = await bottom('grownTail');
  await page.evaluate(() => window.audit.replace('Short tail after shrink.'));
  await page.waitForTimeout(500);
  const shrunkTail = await bottom('shrunkTail');
  assert.ok(grownTail.height - shrunkTail.height > 4000,
    `real row shrink was hidden from measurement: ${grownTail.height} → ${shrunkTail.height}`);
  const blankTail = await page.evaluate(() => {
    const list = document.querySelector('[data-testid="virtuoso-item-list"]');
    const footer = list.nextElementSibling;
    const viewport = list.parentElement;
    return window.audit.ctrl.scrollerRef.current.scrollHeight
      - (footer.getBoundingClientRect().bottom - viewport.getBoundingClientRect().top);
  });
  assert.ok(Math.abs(blankTail) <= 1, `scroll extent left ${blankTail}px beyond natural footer`);

  await geometry('shrunkTail');

  // A fractional footer belongs to the same extent model as fractional rows.
  // Its own ResizeObserver must not round away the fraction or consume the
  // trailing extent padding and feed that padding back into its measurement.
  // The composer spacer helper intentionally ceils its input, so a fractional
  // prop would silently lose coverage. Exercise actual fractional CSS geometry.
  await page.addStyleTag({ content: '[data-chat-footer-spacer] { height: 216.375px !important; }' });
  await page.evaluate(() => window.audit.setLoading(true));
  await page.waitForTimeout(500);
  const fractionalFooter = await bottom('fractionalFooter');
  const footerGeometry = await geometry('fractionalFooter');
  assert.ok(!Number.isInteger(footerGeometry.footerHeight), 'fractional Footer fixture lost coverage');
  await append(' Fractional footer streaming content.'.repeat(40));
  await page.waitForTimeout(500);
  const fractionalGrowth = await bottom('fractionalGrowth');
  await geometry('fractionalGrowth');
  assert.equal(fractionalGrowth.statusY, fractionalFooter.statusY);
  await page.evaluate(() => window.audit.replace('Short again.'));
  await page.waitForTimeout(500);
  const fractionalShrink = await bottom('fractionalShrink');
  await geometry('fractionalShrink');
  assert.equal(fractionalShrink.statusY, fractionalFooter.statusY);

  assert.deepEqual(errors, []);
  await page.evaluate(() => { window.record = false; });
  await writeFile(resolve(output, 'samples.json'), JSON.stringify(await page.evaluate(() => window.samples)));
  await writeFile(resolve(output, 'results.json'), JSON.stringify(evidence, null, 2));
  console.log(`Chat scroll ${engine}: smooth/rapid follow, active cancellation, reduced motion, ${followOnly ? 'height seeds skipped (--follow-only), ' : 'height seeds, '}reading, footer/viewport growth, navigation and terminal checks passed. Evidence: ${output}`);
  }
} finally {
  clearTimeout(deadline);
  if (page && !page.isClosed()) {
    await writeFile(resolve(output, 'last-frame.json'), JSON.stringify(await page.evaluate(() => ({
      samples: window.samples, state: window.audit?.snapshot(),
    })), null, 2));
    await page.screenshot({ path: resolve(output, 'last-frame.png') });
    console.log(`Scroll evidence: ${output}`);
  }
  if (browser) await browser.close();
  await server.close();
}
