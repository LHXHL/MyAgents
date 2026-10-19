import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { patchReactVirtuoso } from './patch-react-virtuoso.mjs';

const installed = resolve(import.meta.dirname, '../node_modules/react-virtuoso');
const names = ['index.mjs', 'index.cjs'];
const sources = names.map(name => readFileSync(resolve(installed, 'dist', name), 'utf8'));
// Reconstruct each previously shipped byte contract, independently of the installer.
const extentRepair = source => source
  .replace("      cancelScrollToIndex: S,\n      scrollTargetReached: w,", "      scrollTargetReached: w,")
  .replace("    { scrollToIndex: y, cancelScrollToIndex },", "    { scrollToIndex: y },")
  .replace("      scrollToIndex: y,\n      cancelScrollToIndex,", "      scrollToIndex: y,")
  .replace("      if (S === \"scrollTo\") f.cancelScrollToIndex?.();\n      const y = f[e.methods[S]];", "      const y = f[e.methods[S]];")
  .replace("    const w = p.behavior === \"smooth\", wasSmooth = l.current !== null;\n    if (c.current !== null) clearTimeout(c.current);\n    c.current = null;\n    l.current = null;", "    const w = p.behavior === \"smooth\";")
  .replace("      if (wasSmooth) T.scrollTo(s === !0 ? { left: f, behavior: \"auto\" } : { top: f, behavior: \"auto\" });\n      t({ scrollHeight: h, scrollTop: f, viewportHeight: R }), w && e(!0);", "      t({ scrollHeight: h, scrollTop: f, viewportHeight: R }), w && e(!0);")
  .replace("  function x(p) {\n    if (c.current !== null) clearTimeout(c.current);\n    c.current = null;\n    l.current = null;\n    s === !0", "  function x(p) {\n    s === !0")
  .replace("{cancelScrollToIndex:S,scrollTargetReached:w,scrollToIndex:T,topListHeight:E}", "{scrollTargetReached:w,scrollToIndex:T,topListHeight:E}")
  .replace("{scrollToIndex:y,cancelScrollToIndex},k,", "{scrollToIndex:y},k,")
  .replace("scrollToIndex:y,cancelScrollToIndex,statefulTotalCount:", "scrollToIndex:y,statefulTotalCount:")
  .replace("a[S]=H=>{if(S===\"scrollTo\")f.cancelScrollToIndex?.();const y=f[e.methods[S]];", "a[S]=H=>{const y=f[e.methods[S]];")
  .replace("const w=p.behavior===\"smooth\",wasSmooth=l.current!==null;if(c.current!==null)clearTimeout(c.current);c.current=null;l.current=null;let E,h,f;", "const w=p.behavior===\"smooth\";let E,h,f;")
  .replace("p.top===f){if(wasSmooth)T.scrollTo(s===!0?{left:f,behavior:\"auto\"}:{top:f,behavior:\"auto\"});t({scrollHeight:h,scrollTop:f,viewportHeight:E})", "p.top===f){t({scrollHeight:h,scrollTop:f,viewportHeight:E})")
  .replace("function I(p){if(c.current!==null)clearTimeout(c.current);c.current=null;l.current=null;s===!0&&(p={...p.behavior", "function I(p){s===!0&&(p={...p.behavior");
const previous = source => extentRepair(source)
  .replace('  const scrollExtent = A("totalListHeight") + A("deviation");\n', '')
  .replace('const scrollExtent=A("totalListHeight")+A("deviation");', '')
  .replace('children: [t, !s && G("div", { "data-virtuoso-scroll-extent": true, "aria-hidden": true, style: { position: "absolute", top: 0, height: scrollExtent, width: 1, pointerEvents: "none" } })]', 'children: t')
  .replace('children:[t,!s&&V.jsx("div",{"data-virtuoso-scroll-extent":true,"aria-hidden":true,style:{position:"absolute",top:0,height:scrollExtent,width:1,pointerEvents:"none"}})]', 'children:t');
const original = source => previous(source)
  .replace('      scrollBy: cancelOnScrollBy,\n', '')
  .replace('    Y(cancelOnScrollBy, S);\n', '')
  .replace('scrollBy:cancelOnScrollBy,', '')
  .replace('Y(cancelOnScrollBy,S);', '');
function fixture(run) {
  const directory = mkdtempSync(resolve(tmpdir(), 'myagents-virtuoso-patch-'));
  try {
    mkdirSync(resolve(directory, 'dist'));
    writeFileSync(resolve(directory, 'package.json'), JSON.stringify({ name: 'react-virtuoso', version: '4.18.3' }));
    names.forEach((name, index) => writeFileSync(resolve(directory, 'dist', name), original(sources[index])));
    run(directory);
  } finally { rmSync(directory, { recursive: true, force: true }); }
}

test('installed dependency is repaired before tests consume it', () => patchReactVirtuoso(installed, true));
test('repairs both module formats and accepts exact idempotent reruns', () => fixture(directory => {
  assert.throws(() => patchReactVirtuoso(directory, true), /npm run postinstall/);
  patchReactVirtuoso(directory);
  patchReactVirtuoso(directory);
  patchReactVirtuoso(directory, true);
  names.forEach((name, index) => assert.equal(readFileSync(resolve(directory, 'dist', name), 'utf8'), sources[index]));
}));
test('upgrades the previously installed cancellation patch without reinstalling', () => fixture(directory => {
  names.forEach((name, index) => writeFileSync(resolve(directory, 'dist', name), previous(sources[index])));
  assert.throws(() => patchReactVirtuoso(directory, true), /npm run postinstall/);
  patchReactVirtuoso(directory);
  patchReactVirtuoso(directory, true);
  names.forEach((name, index) => assert.equal(readFileSync(resolve(directory, 'dist', name), 'utf8'), sources[index]));
}));
test('upgrades the extent repair while retaining internal index measurements', () => fixture(directory => {
  names.forEach((name, index) => writeFileSync(resolve(directory, 'dist', name), extentRepair(sources[index])));
  assert.throws(() => patchReactVirtuoso(directory, true), /npm run postinstall/);
  patchReactVirtuoso(directory);
  patchReactVirtuoso(directory, true);
  names.forEach((name, index) => assert.equal(readFileSync(resolve(directory, 'dist', name), 'utf8'), sources[index]));
}));
test('rejects changed distribution bytes before modifying either module', () => fixture(directory => {
  writeFileSync(resolve(directory, 'dist/index.cjs'), 'unexpected source');
  assert.throws(() => patchReactVirtuoso(directory), /Unexpected react-virtuoso/);
  assert.equal(readFileSync(resolve(directory, 'dist/index.mjs'), 'utf8'), original(sources[0]));
}));
test('requires explicit review when the dependency version changes', () => fixture(directory => {
  writeFileSync(resolve(directory, 'package.json'), JSON.stringify({ name: 'react-virtuoso', version: '4.18.4' }));
  assert.throws(() => patchReactVirtuoso(directory), /Review the scroll regressions/);
  assert.equal(readFileSync(resolve(directory, 'dist/index.mjs'), 'utf8'), original(sources[0]));
}));
