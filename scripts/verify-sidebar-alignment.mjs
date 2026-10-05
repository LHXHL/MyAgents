// Real Sidebar + Theme CSS regression. DOM tests cannot measure font baselines.
// Run: node scripts/verify-sidebar-alignment.mjs webkit
// Or:  node scripts/verify-sidebar-alignment.mjs chromium chrome
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { createServer } from 'vite';
import { webkit, chromium } from 'playwright';

const repo = resolve(import.meta.dirname, '..');
const output = await mkdtemp(resolve(tmpdir(), 'myagents-sidebar-qa-'));
const entryId = repo + '/src/renderer/__sidebar_qa.tsx';
const stub = new Map(Object.entries({
  '@/hooks/useConfig': `const noop=()=>{}; const value={config:{defaultWorkspacePath:'/fixture/mino',agents:[]},projects:[{id:'mino',name:'Mino_T',path:'/fixture/mino',icon:'lightning'},{id:'growth',name:'MA_增长',path:'/fixture/growth',icon:'rocket'},{id:'project',name:'myagents-codex',path:'/fixture/project'},{id:'emoji',name:'Legacy 工作区',path:'/fixture/emoji',icon:'🍀'},{id:'archived',name:'Archived 工作区',path:'/fixture/archived',archivedAt:'2026-10-01T00:00:00Z'}],isLoading:false,error:null,removeProject:noop,patchProject:noop,touchProject:noop,refreshConfig:noop};export const useConfig=()=>value;`,
  '@/hooks/useTaskCenterData': `const data={sessions:[{id:'fixture-session',agentDir:'/fixture/mino',title:'侧栏对齐检查',createdAt:'2026-10-05T00:00:00Z',lastActiveAt:'2026-10-05T00:00:00Z'}],isSessionsLoading:false,error:null,sessionTagsMap:new Map(),workspaceSessionStates:new Map(),deleteProtectedSessionIds:new Set(),refresh:()=>{},actions:{}};export const useGlobalSidebarTaskCenterData=()=>data;`,
  '@/hooks/taskCenterStore': 'export const ensureWorkspaceSessions=()=>{};',
  '@/hooks/useWorkspaceFileService': 'export const useWorkspaceFileService=()=>({openPathExternal:()=>{}});',
  '@/context/SessionDeletionContext': 'export const useSessionDeletion=()=>()=>{};',
  '@/components/Toast': 'export const useToast=()=>({error:console.error,warning:console.warn,success:()=>{},info:()=>{}});',
  '@/features/account/useMyAgentsAccount': `const account={scope:'production',enabled:false,generation:0,loadState:'ready',view:null,error:null,avatarPresets:{people:[],agents:[],lastFetchedAt:0,isLoading:false,error:null}};export const useMyAgentsAccount=()=>account;`,
  '@/notifications/useNotificationCenter': `const value={snapshot:{loadState:'ready',authState:'signed_out',items:[],hasUnread:true,hasMore:false,isLoadingMore:false,feedCutoff:null,lastSyncedAt:null,errorCode:null},refresh:()=>{},loadMore:()=>{},markAllRead:()=>{}};export const useNotificationCenter=()=>value;`,
  '@/utils/browserMock': 'export * from "/utils/browserMock.ts?fixture-original";export const isTauriEnvironment=()=>true;export const isBrowserDevMode=()=>false;export const pickFolderForDialog=()=>null;',
  '@/components/FeedbackPopover': 'export default function FeedbackPopover(){return null;}',
  '@/analytics': 'export const track=()=>{};',
  '@/components/HistorySearchOverlayContent': `import React from 'react';export default function Search({onClose}){return React.createElement('div',null,React.createElement('input',{autoFocus:true,'aria-label':'搜索历史'}),React.createElement('button',{onClick:onClose},'关闭搜索'));}`,
}));
const entry = `import React,{useState} from 'react';import {createRoot} from 'react-dom/client';import {i18n} from './i18n';import {ThemeRuntimeProvider} from './theme/ThemeRuntime';import GlobalSidebar from './components/global-sidebar/GlobalSidebar';import './index.css';await i18n.changeLanguage('zh-CN');
const noop=()=>{};const yes=async()=>true;const tab={id:'launcher',view:'launcher',title:'Launcher'};window.audit={network:0,space:0};
function Fixture(){const [appearanceMode,setAppearanceMode]=useState('light');const [themeId,setThemeId]=useState('myagents-light');window.audit.theme=setAppearanceMode;window.audit.themeId=setThemeId;window.audit.language=(l)=>i18n.changeLanguage(l);return <ThemeRuntimeProvider selection={{themeId,appearanceMode}}><div style={{display:'flex'}}><GlobalSidebar tabs={[tab]} activeTab={tab} activeWorkspacePath={null} teamSpaceAvailable onNewTab={noop} onOpenTaskCenter={noop} onCreateTask={noop} onOpenSpace={()=>window.audit.space++} onOpenAgentNetwork={()=>window.audit.network++} onOpenCapabilities={noop} onOpenSettings={noop} onOpenBugReport={noop} onOpenWorkspace={yes} onOpenSession={yes} onRenameSession={async()=>null} newAgentPanelOpen={false} onNewAgentPanelOpenChange={noop}/><main style={{flex:1,background:'var(--paper)',padding:32}}><p style={{color:'var(--ink-muted)'}}>MyAgents</p></main></div></ThemeRuntimeProvider>};createRoot(document.getElementById('root')).render(<Fixture/>);`;

const server = await createServer({
  configFile: resolve(repo, 'vite.config.ts'),
  cacheDir: resolve(output,'vite-cache'),
  optimizeDeps:{exclude:['chartjs-umd-source','d3-umd-source','lucide-umd-source']},
  server:{host:'127.0.0.1',port:0},
  plugins:[{name:'sidebar-qa-fixture',enforce:'pre',resolveId(id){
    if(id==='/__sidebar_qa.tsx')return entryId;
    for(const key of stub.keys())if(id===key||id===repo+'/src/renderer/'+key.slice(2))return '\0sidebar-qa:'+key;
  },load(id){if(id===entryId)return entry;if(id.startsWith('\0sidebar-qa:'))return stub.get(id.slice(12));},configureServer(vite){vite.middlewares.use(async(req,res,next)=>{if(req.url!=='/__sidebar_qa')return next();res.setHeader('Content-Type','text/html');res.end(await vite.transformIndexHtml(req.url,'<html><body><div id="root"></div><script type="module" src="/__sidebar_qa.tsx"></script></body></html>'));});}}],
});


const engine = process.argv[2] || 'webkit';
assert.ok(['webkit', 'chromium'].includes(engine), 'Choose webkit or chromium');
const browser = await ({ webkit, chromium })[engine].launch({
  headless: true,
  ...(process.argv[3] ? { channel: process.argv[3] } : {}),
});
const evidence = [];
try {
  await server.listen();
  const { port } = server.httpServer.address();
  const page = await browser.newPage({ viewport: { width: 1440, height: 860 }, deviceScaleFactor: 2 });
  // Services are fixture inputs; all layout, fonts, icons and interactions are real.
  await page.route('**/*', route => new URL(route.request().url()).hostname === '127.0.0.1'
    ? route.continue() : route.abort());
  await page.goto(`http://127.0.0.1:${port}/__sidebar_qa`);
  await page.locator('[data-global-sidebar-search-trigger]').waitFor();
  await page.locator('[data-global-sidebar-archived-toggle]').click();

  const measure = (selector = 'body') => page.evaluate(selector => {
    const root = document.querySelector(selector);
    const context = document.createElement('canvas').getContext('2d');
    const labels = [
      ...root.querySelectorAll('.global-sidebar-nav-label, [data-global-sidebar-workspace-title], [data-global-sidebar-session-title]'),
      root.querySelector('[data-global-account-trigger] > span:last-child'),
      root.querySelector('[data-global-sidebar-archived-toggle] > span:nth-child(2)'),
      ...[...root.querySelectorAll('[data-global-sidebar-archived-toggle] + div > div')]
        .map(row => row.querySelector(':scope > span.truncate')),
    ].filter(label => label && label.getBoundingClientRect().width > 0);
    return labels.map(label => {
      const style = getComputedStyle(label);
      const probe = document.createElement('span');
      probe.style.cssText = 'display:inline-block;width:0;height:0;vertical-align:baseline';
      label.appendChild(probe);
      const baseline = probe.getBoundingClientRect().top;
      probe.remove();
      context.font = `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
      const metrics = context.measureText(label.textContent.trim());
      const row = label.closest('button, .group\\/archive').getBoundingClientRect();
      return {
        text: label.textContent.trim(),
        delta: baseline + (metrics.actualBoundingBoxDescent - metrics.actualBoundingBoxAscent) / 2
          - (row.top + row.height / 2),
      };
    });
  }, selector);

  for (const themeId of ['myagents-default', 'myagents-light', 'codex']) {
    for (const language of ['zh-CN', 'en-US']) {
      for (const mode of ['light', 'dark']) {
        await page.evaluate(async ({ themeId, language, mode }) => {
          window.audit.themeId(themeId); window.audit.theme(mode);
          await window.audit.language(language);
        }, { themeId, language, mode });
        await page.waitForTimeout(220);
        const rows = await measure();
        assert.ok(rows.length >= 14, `Missing a sidebar row: ${JSON.stringify(rows)}`);
        // Ink bounds are a proxy, not a pixel-perfect optical centroid. Allow
        // normal character/engine variation, but reject the >1px baseline drift.
        for (const row of rows) assert.ok(Math.abs(row.delta) <= 1,
          `${themeId}/${language}/${mode}: text is off its row center: ${JSON.stringify(row)}`);
        evidence.push({ themeId, language, mode, rows });
      }
    }
  }

  await page.screenshot({ path: resolve(output, 'expanded.png'), clip: { x: 0, y: 0, width: 280, height: 860 } });
  const controls = () => page.evaluate(() => {
    const search = document.querySelector('[data-global-sidebar-search-trigger]');
    const bell = document.querySelector('[data-notification-center-trigger]');
    return [search, bell].map(button => {
      const b = button.getBoundingClientRect(), icon = button.querySelector('svg').getBoundingClientRect();
      return { x: b.x, y: b.y, width: b.width, height: b.height,
        iconDelta: icon.top + icon.height / 2 - (b.top + b.height / 2) };
    });
  });
  const before = await controls();
  await page.locator('[data-global-sidebar-toggle]').click();
  await page.waitForTimeout(240);
  const rail = await controls();
  for (let i = 0; i < rail.length; i++) {
    assert.equal(rail[i].width, 32); assert.equal(rail[i].height, 32);
    assert.equal(rail[i].x, 16); assert.equal(rail[i].y, before[i].y);
    assert.equal(rail[i].iconDelta, 0);
  }
  await page.locator('[data-global-sidebar-workspace-rail] button').click();
  await page.locator('[data-global-sidebar-flyout]').waitFor();
  // Presence precedes the existing 140ms entrance. Measure settled geometry
  // and capture visible pixels rather than a near-transparent first frame.
  await page.locator('[data-global-sidebar-flyout]').evaluate(async panel => {
    await Promise.all(panel.getAnimations().map(animation => animation.finished));
  });
  assert.equal(await page.locator('[data-global-sidebar-flyout]').evaluate(panel => getComputedStyle(panel).opacity), '1');
  const flyout = await measure('[data-global-sidebar-flyout]');
  assert.ok(flyout.length >= 7, 'Missing flyout resource rows');
  for (const row of flyout) assert.ok(Math.abs(row.delta) <= 1, JSON.stringify(row));
  await page.screenshot({ path: resolve(output, 'flyout.png'), clip: { x: 0, y: 0, width: 420, height: 860 } });
  await writeFile(resolve(output, 'evidence.json'), JSON.stringify({ engine, evidence, before, rail, flyout }, null, 2));
  console.log(JSON.stringify({ result: 'PASS', engine, states: evidence.length, output }));
} finally {
  await browser.close(); await server.close();
}
