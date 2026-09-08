// Offline regression using real Message/Markdown, controller, CSS and Virtuoso.
// Usage: npm run verify:chat-scroll -- webkit (or chrome / chromium).
// Videos and geometry evidence are retained in the printed temporary directory.
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { createServer } from 'vite';
import { chromium, webkit } from 'playwright';
import { patchReactVirtuoso } from './patch-react-virtuoso.mjs';

const repo = resolve(import.meta.dirname, '..');
patchReactVirtuoso(resolve(repo, 'node_modules/react-virtuoso'), true);
const output = await mkdtemp(resolve(tmpdir(), 'myagents-scroll-verification-'));
const engine = process.argv[2] ?? 'webkit';
assert.ok(['webkit', 'chrome', 'chromium'].includes(engine), 'Choose webkit, chrome or chromium');
const entryId = repo + '/src/renderer/__scroll_audit.tsx';
const entry=`import React,{useState,useRef,useLayoutEffect} from 'react';
import {createRoot} from 'react-dom/client';
import {i18n} from './i18n';
import './index.css';
import MessageList from './components/MessageList';
import {ImagePreviewProvider} from './context/ImagePreviewContext';
import {useChatScrollModel} from './hooks/useChatScrollModel';
import {useChatScrollController} from './hooks/useChatScrollController';
import {useChatSearch} from './hooks/useChatSearch';
await i18n.changeLanguage('zh-CN');
const mk=(id,content,role='assistant')=>({id,content,role,timestamp:new Date(),streamingTextActive:true});
const history=Array.from({length:25},(_,i)=>mk('h'+i,('History paragraph '+i+' with stable lines. ').repeat(15)));
function Fixture(){
 const [sm,setSm]=useState(mk('stream','Streaming start.'));
 const [loading,setLoading]=useState(true);
 const [permission,setPermission]=useState(false);
 const [searchOpen,setSearchOpen]=useState(false);
 const [height,setHeight]=useState(640);
 const [spacer,setSpacer]=useState(176);
 const rootRef=useRef(null);
 const model=useChatScrollModel({historyMessages:history,streamingMessage:sm,sessionId:'audit'});
 const ctrl=useChatScrollController({messages:model.data,isActive:true,sessionId:'audit',rootRef});
 const search=useChatSearch({active:searchOpen,messages:model.data,scrollerRef:ctrl.scrollerRef,scrollToMessage:ctrl.scrollToMessage,pauseAutoScroll:ctrl.pauseAutoScroll});
 useLayoutEffect(()=>{window.audit={ctrl,search,setSearchOpen,setLoading,setHeight,setSpacer,setPermission,
 showDisclosure:()=>setSm(prev=>({...prev,content:[{type:'thinking',thinking:'Expanded thinking content with many lines. '.repeat(100),isComplete:true},{type:'text',text:'Disclosure tail.'}]})),
 growDisclosure:()=>setSm(prev=>({...prev,content:prev.content.map(block=>block.type==='text'?{...block,text:block.text+' Later output below the open content. '.repeat(20)}:block)})),append:text=>setSm(prev=>({...prev,content:prev.content+text})),replace:text=>setSm(prev=>({...prev,content:text})),snapshot:()=>{
  const el=ctrl.scrollerRef.current; const status=document.querySelector('[data-chat-status-row]');
  const er=el?.getBoundingClientRect();
  const rows=[...document.querySelectorAll('[data-message-id]')];
  const anchor=rows.find(row=>row.getBoundingClientRect().bottom>(er?.top??0));
  return {top:el?.scrollTop,height:el?.scrollHeight,viewport:el?.clientHeight,gap:el?el.scrollHeight-el.scrollTop-el.clientHeight:null,follow:ctrl.followEnabledRef.current,statusY:status?.getBoundingClientRect().top,statusH:status?.getBoundingClientRect().height,anchor:anchor?.dataset.messageId,anchorY:anchor?anchor.getBoundingClientRect().top-er.top:null};
 }}});
 return <div ref={rootRef} style={{height,width:760,display:'flex',flexDirection:'column',position:'relative',overflow:'hidden'}}>
 <MessageList messages={model.data} streamingMessage={sm} isLoading={loading} sessionState={loading?'running':'idle'} isStreaming={loading} sessionId="audit"
 heightEstimateSeed={model.heightEstimateSeed} layoutByMessageId={model.layoutByMessageId} virtuosoRef={ctrl.virtuosoRef}
 onScrollerRef={ctrl.attachScroller} followEnabledRef={ctrl.followEnabledRef} scrollToBottom={ctrl.scrollToBottom} handleAtBottomChange={ctrl.handleAtBottomChange}
 onViewportAdmissionChanged={ctrl.onViewportAdmissionChanged} onItemsRendered={ctrl.onItemsRendered} isViewportRecoveryFenced={ctrl.isViewportRecoveryFenced}
 onRowLayoutChanged={ctrl.onRowLayoutChanged} bottomSpacerPx={spacer}
 pendingPermission={permission?{requestId:'fixture-permission',toolName:'Bash',input:'{"command":"pwd"}'}:null}
 onPermissionDecision={()=>setPermission(false)} />
 </div>;
}
createRoot(document.getElementById('root')).render(<ImagePreviewProvider><Fixture/></ImagePreviewProvider>);`;
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
        if (req.url !== '/__scroll_audit') return next();
        res.setHeader('Content-Type', 'text/html');
        res.end(await vite.transformIndexHtml(req.url, '<html><head><style>:root{--font-body:Arial,sans-serif;--font-code:monospace;--paper:white;--ink:black;--ink-muted:#666}body{margin:0}[data-chat-status-row]{outline:2px solid rgb(255,0,255)}</style></head><body><div id="root"></div><script type="module" src="/__scroll_audit.tsx"></script></body></html>'));
      });
    },
  }],
});
let browser;
const deadline = setTimeout(() => void browser?.close(), 120000);
try {
  await server.listen();
  browser = await (engine === 'webkit' ? webkit : chromium).launch({
    headless: true, ...(engine === 'chrome' ? { channel: 'chrome' } : {}),
  });
  const page = await browser.newPage({ viewport: { width: 1000, height: 800 },
    recordVideo: { dir: output, size: { width: 1000, height: 800 } } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const address = server.httpServer.address();
  await page.goto(`http://127.0.0.1:${address.port}/__scroll_audit`);
  await page.waitForFunction(() => window.audit?.ctrl.scrollerRef.current);
  await page.waitForTimeout(1500);
  const snapshot = () => page.evaluate(() => window.audit.snapshot());
  const evidence = {};
  const bottom = async label => {
    const state = evidence[label] = await snapshot();
    assert.ok(Math.abs(state.gap) <= 1, `${label}: bottom gap ${state.gap}`);
    assert.notEqual(state.follow, false, `${label}: follow was disabled`);
    return state;
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
  const status = await page.locator('[data-chat-status-row]').elementHandle();
  for (let i = 0; i < 80; i++) {
    await append(` New content ${i} grows while loading stays true.`);
    await page.waitForTimeout(24);
  }
  await page.waitForTimeout(300);
  const streamed = await bottom('streamed');
  assert.equal(streamed.statusY, initial.statusY);
  assert.ok(await status.evaluate(el => el === document.querySelector('[data-chat-status-row]')));

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

  assert.deepEqual(errors, []);
  await page.evaluate(() => { window.record = false; });
  await writeFile(resolve(output, 'samples.json'), JSON.stringify(await page.evaluate(() => window.samples)));
  await writeFile(resolve(output, 'results.json'), JSON.stringify(evidence, null, 2));
  console.log(`Chat scroll ${engine}: streaming, reading, footer/viewport growth, navigation cancellation and terminal checks passed. Evidence: ${output}`);
} finally {
  clearTimeout(deadline);
  if (browser) await browser.close();
  await server.close();
}
