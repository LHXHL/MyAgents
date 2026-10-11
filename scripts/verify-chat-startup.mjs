// Offline startup handoff regression with the real shell, Message and Virtuoso.
// Run: node scripts/verify-chat-startup.mjs webkit (or chrome / chromium).
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { createServer } from 'vite';
import { chromium, webkit } from 'playwright';

const repo = resolve(import.meta.dirname, '..');
const output = await mkdtemp(resolve(tmpdir(), 'myagents-startup-verification-'));
const engine = process.argv[2] ?? 'webkit';
assert.ok(['webkit', 'chrome', 'chromium'].includes(engine));
const entryId = repo + '/src/renderer/__startup_audit.tsx';
const entry = `import React,{useState,useRef,useLayoutEffect} from 'react';
import {createRoot} from 'react-dom/client';
import {i18n} from './i18n';
import {ThemeRuntimeProvider} from './theme/ThemeRuntime';
import {ImagePreviewProvider} from './context/ImagePreviewContext';
import MessageList from './components/MessageList';
import ChatBootOverlay from './components/ChatBootOverlay';
import {useChatStartupOverlay} from './hooks/useChatStartupOverlay';
import {useChatScrollModel} from './hooks/useChatScrollModel';
import {useChatScrollController} from './hooks/useChatScrollController';
import './index.css';
await i18n.changeLanguage('zh-CN');
const mode=new URLSearchParams(location.search).get('mode');
const mk=(id,content,requestId)=>({id,role:'user',content,timestamp:new Date(),metadata:{source:'desktop',clientRequestId:requestId}});
const old=mode==='fork'?Array.from({length:30},(_,i)=>mk('old-'+i,'Copied history '+i,'old-request-'+i)):[];
const query=mode==='long'?'Long startup query paragraph. '.repeat(120):mode==='image'?'':'Submitted startup query';
function Fixture(){
 const [rows,setRows]=useState(old);
 const rootRef=useRef(null);
 const boot=useChatStartupOverlay({hasInitialMessage:true,isConnected:true,isSessionLoading:false,agentError:null,hasPendingInteraction:false});
 const model=useChatScrollModel({historyMessages:rows,streamingMessage:null,sessionId:'audit'});
 const ctrl=useChatScrollController({messages:model.data,isActive:true,sessionId:'audit',rootRef});
 const next=()=>({...mk('accepted-query',query,boot.startupClientRequestId),...(mode==='image'?{attachments:[{id:'image',name:'query.svg',size:1,mimeType:'image/svg+xml',isImage:true,previewUrl:'data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg" width="180" height="100"%3E%3Crect width="180" height="100" fill="teal"/%3E%3C/svg%3E'}]}:{})});
 useLayoutEffect(()=>{window.audit={optimistic:()=>setRows([...old,{...next(),id:'pending-query',deliveryStatus:'sending'}]),accept:()=>setRows([...old,next()]),show:boot.showStartupOverlay};});
 return <div ref={rootRef} style={{height:640,width:760,display:'flex',flexDirection:'column',position:'relative',overflow:'hidden'}}>
 <MessageList messages={model.data} streamingMessage={null} isLoading sessionState="idle" isActive sessionId="audit"
 firstItemIndex={model.firstItemIndex} heightEstimateSeed={model.heightEstimateSeed} layoutByMessageId={model.layoutByMessageId}
 virtuosoRef={ctrl.virtuosoRef} onScrollerRef={ctrl.attachScroller} followEnabledRef={ctrl.followEnabledRef}
 scrollToBottom={ctrl.scrollToBottom} handleAtBottomChange={ctrl.handleAtBottomChange}
 onViewportAdmissionChanged={ctrl.onViewportAdmissionChanged} isViewportRecoveryFenced={ctrl.isViewportRecoveryFenced}
 onItemsRendered={items=>{ctrl.onItemsRendered();boot.onStartupItemsRendered(items);}} bottomSpacerPx={140} />
 <ChatBootOverlay show={boot.showStartupOverlay}/>
 </div>;
}
createRoot(document.getElementById('root')).render(<ThemeRuntimeProvider selection={null}><ImagePreviewProvider><Fixture/></ImagePreviewProvider></ThemeRuntimeProvider>);`;
const server = await createServer({
  configFile: resolve(repo, 'vite.config.ts'),
  cacheDir: resolve(output, 'vite-cache'),
  optimizeDeps: { exclude: ['chartjs-umd-source', 'd3-umd-source', 'lucide-umd-source',
    'chartjs-umd-source?raw', 'd3-umd-source?raw', 'lucide-umd-source?raw'] },
  server: { host: '127.0.0.1', port: 0 },
  plugins: [{ name: 'startup-fixture', enforce: 'pre',
    resolveId(id) { if (id === '/__startup_audit.tsx') return entryId; },
    load(id) { if (id === entryId) return entry; },
    configureServer(vite) {
      vite.middlewares.use(async (req, res, next) => {
        if (req.url?.split('?')[0] !== '/__startup_audit') return next();
        res.setHeader('Content-Type', 'text/html');
        res.end(await vite.transformIndexHtml(req.url, '<html><head><style>body{margin:0}</style></head><body><div id="root"></div><script type="module" src="/__startup_audit.tsx"></script></body></html>'));
      });
    },
  }],
});
let browser;
try {
  await server.listen();
  browser = await (engine === 'webkit' ? webkit : chromium).launch({ headless: true,
    ...(engine === 'chrome' ? { channel: 'chrome' } : {}) });
  const page = await browser.newPage({ viewport: { width: 900, height: 740 },
    recordVideo: { dir: output, size: { width: 900, height: 740 } } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const address = server.httpServer.address();
  const evidence = {};
  for (const mode of ['short', 'long', 'image', 'fork']) {
    await page.goto('http://127.0.0.1:' + address.port + '/__startup_audit?mode=' + mode);
    await page.waitForFunction(() => window.audit);
    await page.waitForTimeout(100);
    assert.equal(await page.evaluate(() => window.audit.show), true, mode + ': copied history must not dismiss startup');
    await page.evaluate(() => window.audit.optimistic());
    await page.waitForSelector('[data-message-id="pending-query"]');
    await page.waitForTimeout(100);
    assert.equal(await page.evaluate(() => window.audit.show), true, mode + ': optimistic query must not dismiss startup');
    assert.equal(await page.locator('[aria-live="polite"] article').count(), 0);
    if (mode === 'short') await page.screenshot({ path: resolve(output, engine + '-startup.png') });
    await page.evaluate(() => {
      window.framesAudit = [];
      const deadline = performance.now() + 650;
      const sample = () => {
        const overlay = document.querySelector('.z-30[aria-hidden]');
        const row = document.querySelector('[data-message-id="accepted-query"]');
        const viewport = document.querySelector('[data-viewport-phase]');
        const rr = row?.getBoundingClientRect(), vr = viewport?.getBoundingClientRect();
        window.framesAudit.push({ opacity: Number(getComputedStyle(overlay).opacity),
          presented: !!rr && rr.height > 0 && rr.bottom > vr.top && rr.top < vr.bottom,
          y: rr?.top, height: rr?.height });
        if (performance.now() < deadline) requestAnimationFrame(sample);
      };
      window.audit.accept();
      requestAnimationFrame(sample);
    });
    await page.waitForFunction(() => window.audit.show === false);
    await page.waitForTimeout(700);
    const frames = await page.evaluate(() => window.framesAudit);
    const revealed = frames.filter(frame => frame.opacity < 0.99);
    assert.ok(revealed.length > 0, mode + ': fades out');
    assert.ok(revealed.every(frame => frame.presented), mode + ': no revealed frame lacks its accepted query');
    if (mode === 'short' || mode === 'image') {
      const positions = revealed.map(frame => frame.y);
      assert.ok(Math.max(...positions) - Math.min(...positions) <= 2, mode + ': query stays in place throughout fade');
    }
    evidence[mode] = frames;
    if (mode === 'short') await page.screenshot({ path: resolve(output, engine + '-ready.png') });
  }
  assert.deepEqual(errors, []);
  await writeFile(resolve(output, 'frames.json'), JSON.stringify(evidence, null, 2));
  console.log(engine + ': startup handoff passed (text, long query, image, fork). Evidence: ' + output);
} finally {
  await browser?.close();
  await server.close();
}
