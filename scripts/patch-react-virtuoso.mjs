// react-virtuoso 4.18.3: a newer pixel scroll must cancel the older index
// navigation's listRefresh / smooth-target retry subscriptions. Otherwise upward
// user input stops the native animation but a late measurement replays the jump.
// Only imperative pixel calls revoke the index owner; its internal scrollTo
// output must keep its measurement transaction alive. Native motion owns its
// own completion timer and must retire it even on same-offset takeover.
// WebKit also clamps scrollTop while React removes range items before updating
// the list padding. Project the virtualizer's existing totalListHeight + deviation
// as an absolute, non-measuring viewport child, keeping the scroll extent intact
// through that commit. Do NOT constrain the measured list: that hides shrinkage
// from its ResizeObserver. Rows, header and footer still size naturally.
// Keep row/header/footer measurements fractional. Round only the complete
// element-scroll extent, projecting the remainder into existing trailing list
// padding (outside measured children). Model and natural layout then agree and
// the footer does not drift against integer native scroll coordinates.
// Remove these patches once upstream passes verify-chat-scroll.mjs.
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const patches = {
  "index.mjs": {
    "original": "92312b36ddbba75a6b162389962cb8890bf7faed340bc63201dcd1d439ed1729",
    "repaired": "ffa93e7e28e03b003e2cd742b24e404e87d9fa3be8032d6e154ef94ef20d7429",
    "changes": [
      [
        "      scrollTo: d,\n      smoothScrollTargetReached: m,",
        "      scrollTo: d,\n      scrollBy: cancelOnScrollBy,\n      smoothScrollTargetReached: m,"
      ],
      [
        "    return L(\n      I(\n        T,\n        $(n, x, o, R, l, i, p),",
        "    Y(cancelOnScrollBy, S);\n    return L(\n      I(\n        T,\n        $(n, x, o, R, l, i, p),"
      ],
      [
        "const fr = ({ children: t }) => {",
        "const fr = ({ children: t }) => {\n  const scrollExtent = A(\"totalListHeight\") + A(\"deviation\");"
      ],
      [
        "style: Jt(r), children: t",
        "style: Jt(r), children: [t, !s && G(\"div\", { \"data-virtuoso-scroll-extent\": true, \"aria-hidden\": true, style: { position: \"absolute\", top: 0, height: scrollExtent, width: 1, pointerEvents: \"none\" } })]"
      ],
      [
        "      scrollTargetReached: w,",
        "      cancelScrollToIndex: S,\n      scrollTargetReached: w,"
      ],
      [
        "    { scrollToIndex: y },",
        "    { scrollToIndex: y, cancelScrollToIndex },"
      ],
      [
        "      scrollToIndex: y,",
        "      scrollToIndex: y,\n      cancelScrollToIndex,"
      ],
      [
        "      const y = f[e.methods[S]];",
        "      if (S === \"scrollTo\") f.cancelScrollToIndex?.();\n      const y = f[e.methods[S]];"
      ],
      [
        "    const w = p.behavior === \"smooth\";",
        "    const w = p.behavior === \"smooth\", wasSmooth = l.current !== null;\n    if (c.current !== null) clearTimeout(c.current);\n    c.current = null;\n    l.current = null;"
      ],
      [
        "      t({ scrollHeight: h, scrollTop: f, viewportHeight: R }), w && e(!0);",
        "      if (wasSmooth) T.scrollTo(s === !0 ? { left: f, behavior: \"auto\" } : { top: f, behavior: \"auto\" });\n      t({ scrollHeight: h, scrollTop: f, viewportHeight: R }), w && e(!0);"
      ],
      [
        "  function x(p) {\n    s === !0",
        "  function x(p) {\n    if (c.current !== null) clearTimeout(c.current);\n    c.current = null;\n    l.current = null;\n    s === !0"
      ],
      [
        "  const E = A(\"EmptyPlaceholder\"), y = A(\"ScrollSeekPlaceholder\") ?? rr,",
        "  const extent = A(\"totalListHeight\") + a;\n  const endPadding = !r && !s && !h ? Math.ceil(extent) - extent : 0;\n  const E = A(\"EmptyPlaceholder\"), y = A(\"ScrollSeekPlaceholder\") ?? rr,"
      ],
      [
        "paddingBottom: n.offsetBottom,",
        "paddingBottom: n.offsetBottom + endPadding,"
      ],
      [
        "height: scrollExtent, width: 1",
        "height: Math.ceil(scrollExtent), width: 1"
      ],
      [
        "const e = A(\"HeaderComponent\"), n = Ct(\"headerHeight\"), o = A(\"HeaderFooterTag\"), r = kt(\n    H.useMemo(\n      () => (i) => {\n        n(Et(i, \"height\"));",
        "const e = A(\"HeaderComponent\"), n = Ct(\"headerHeight\"), o = A(\"HeaderFooterTag\"), r = kt(\n    H.useMemo(\n      () => (i) => {\n        n(i.getBoundingClientRect().height);"
      ],
      [
        "const e = A(\"FooterComponent\"), n = Ct(\"footerHeight\"), o = A(\"HeaderFooterTag\"), r = kt(\n    H.useMemo(\n      () => (i) => {\n        n(Et(i, \"height\"));",
        "const e = A(\"FooterComponent\"), n = Ct(\"footerHeight\"), o = A(\"HeaderFooterTag\"), r = kt(\n    H.useMemo(\n      () => (i) => {\n        n(i.getBoundingClientRect().height);"
      ],
      [
        "T = v((u, g) => Et(u, Fo[g]))",
        "T = v((u, g) => u.getBoundingClientRect()[Fo[g]])"
      ]
    ],
    "previous": [
      "a0e01cf265391f9d99d0baa496b6f75d93caf6c5e8217f4f3912667029fbc1a7",
      "b46cc9dd63ddb26bd84a59cfb0c31c71a9b462a0845fc964c08998c44219eca8",
      "76e9dda9cc0cea2bd62dc4334796145298dd1aeec2950b7e1784a925a4759f7e"
    ]
  },
  "index.cjs": {
    "original": "47bb8592d307cb2847ceec6d5a0a8661004a99344a42c46c30007d0f120b71b7",
    "repaired": "82502785b5941562dfd95711a046d93980cbdafee156418a1b446b9f59e33b3b",
    "changes": [
      [
        "scrollingInProgress:c,scrollTo:d,smoothScrollTargetReached:m,viewportHeight:I",
        "scrollingInProgress:c,scrollTo:d,scrollBy:cancelOnScrollBy,smoothScrollTargetReached:m,viewportHeight:I"
      ],
      [
        "j(c,!1)}return L(x(T,D(n,I,o,E,l,i,p)",
        "j(c,!1)}Y(cancelOnScrollBy,S);return L(x(T,D(n,I,o,E,l,i,p)"
      ],
      [
        "const ar=({children:t})=>{",
        "const ar=({children:t})=>{const scrollExtent=A(\"totalListHeight\")+A(\"deviation\");"
      ],
      [
        "style:Zt(r),children:t",
        "style:Zt(r),children:[t,!s&&V.jsx(\"div\",{\"data-virtuoso-scroll-extent\":true,\"aria-hidden\":true,style:{position:\"absolute\",top:0,height:scrollExtent,width:1,pointerEvents:\"none\"}})]"
      ],
      [
        "{scrollTargetReached:w,scrollToIndex:T,topListHeight:E}",
        "{cancelScrollToIndex:S,scrollTargetReached:w,scrollToIndex:T,topListHeight:E}"
      ],
      [
        "{scrollToIndex:y},k,",
        "{scrollToIndex:y,cancelScrollToIndex},k,"
      ],
      [
        "scrollToIndex:y,statefulTotalCount:",
        "scrollToIndex:y,cancelScrollToIndex,statefulTotalCount:"
      ],
      [
        "a[S]=H=>{const y=f[e.methods[S]];",
        "a[S]=H=>{if(S===\"scrollTo\")f.cancelScrollToIndex?.();const y=f[e.methods[S]];"
      ],
      [
        "const w=p.behavior===\"smooth\";let E,h,f;",
        "const w=p.behavior===\"smooth\",wasSmooth=l.current!==null;if(c.current!==null)clearTimeout(c.current);c.current=null;l.current=null;let E,h,f;"
      ],
      [
        "p.top===f){t({scrollHeight:h,scrollTop:f,viewportHeight:E})",
        "p.top===f){if(wasSmooth)T.scrollTo(s===!0?{left:f,behavior:\"auto\"}:{top:f,behavior:\"auto\"});t({scrollHeight:h,scrollTop:f,viewportHeight:E})"
      ],
      [
        "function I(p){s===!0&&(p={...p.behavior",
        "function I(p){if(c.current!==null)clearTimeout(c.current);c.current=null;l.current=null;s===!0&&(p={...p.behavior"
      ],
      [
        "const H=A(\"EmptyPlaceholder\"),y=A(\"ScrollSeekPlaceholder\")??nr,",
        "const extent=A(\"totalListHeight\")+a;const endPadding=!r&&!s&&!h?Math.ceil(extent)-extent:0;const H=A(\"EmptyPlaceholder\"),y=A(\"ScrollSeekPlaceholder\")??nr,"
      ],
      [
        "paddingBottom:n.offsetBottom,",
        "paddingBottom:n.offsetBottom+endPadding,"
      ],
      [
        "height:scrollExtent,width:1",
        "height:Math.ceil(scrollExtent),width:1"
      ],
      [
        "const e=A(\"HeaderComponent\"),n=Ct(\"headerHeight\"),o=A(\"HeaderFooterTag\"),r=kt(b.useMemo(()=>i=>{n(Et(i,\"height\"))",
        "const e=A(\"HeaderComponent\"),n=Ct(\"headerHeight\"),o=A(\"HeaderFooterTag\"),r=kt(b.useMemo(()=>i=>{n(i.getBoundingClientRect().height)"
      ],
      [
        "const e=A(\"FooterComponent\"),n=Ct(\"footerHeight\"),o=A(\"HeaderFooterTag\"),r=kt(b.useMemo(()=>i=>{n(Et(i,\"height\"))",
        "const e=A(\"FooterComponent\"),n=Ct(\"footerHeight\"),o=A(\"HeaderFooterTag\"),r=kt(b.useMemo(()=>i=>{n(i.getBoundingClientRect().height)"
      ],
      [
        "v((u,g)=>Et(u,Lo[g]))",
        "v((u,g)=>u.getBoundingClientRect()[Lo[g]])"
      ]
    ],
    "previous": [
      "6bf9bd817e5ba78198f9b83370d65b8ea6b04c02b999ec98acf925779f867af6",
      "a45404b8f7a090805439919cf418149a32b0a923d56475a4ae278cc35c183571",
      "8c5e4b3d957a88ae7a8861e5db62708eb622f289959e06e02a0038546bc6861f"
    ]
  }
};
const digest = source => createHash('sha256').update(source).digest('hex');

export function patchReactVirtuoso(directory, check = false) {
  const metadata = JSON.parse(readFileSync(resolve(directory, 'package.json'), 'utf8'));
  if (metadata.name !== 'react-virtuoso' || metadata.version !== '4.18.3') {
    throw new Error('Chat scroll repair requires react-virtuoso 4.18.3. Review the scroll regressions before upgrading.');
  }
  const pending = Object.entries(patches).flatMap(([name, patch]) => {
    const path = resolve(directory, 'dist', name), source = readFileSync(path, 'utf8');
    if (digest(source) === patch.repaired) return [];
    if (digest(source) !== patch.original && !patch.previous.includes(digest(source))) throw new Error('Unexpected react-virtuoso bytes: ' + name);
    if (check) throw new Error('Chat scroll repair is missing. Run npm run postinstall.');
    const result = patch.changes.reduce((text, [from, to]) => text.includes(to) ? text : text.replace(from, to), source);
    if (digest(result) !== patch.repaired) throw new Error('Chat scroll repair mismatch: ' + name);
    return [{ path, result }];
  });
  for (const { path, result } of pending) writeFileSync(path, result);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  patchReactVirtuoso(resolve(import.meta.dirname, '../node_modules/react-virtuoso'), process.argv.includes('--check'));
}
