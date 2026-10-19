import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

// Real virtualizer transactions: mocked scroll handles cannot reproduce the
// retained listRefresh / smooth completion subscriptions inside Virtuoso.
export async function verifyScrollOwnership(page, fixtureUrl, output) {
  await page.addInitScript(() => {
    window.VIRTUOSO_LOG_LEVEL = 0;
    window.scrollOwnershipTrace = [];
    const debug = console.debug;
    console.debug = (...args) => {
      if (args.some(arg => typeof arg === 'string' && arg.includes('scrolling from index to'))) {
        window.scrollOwnershipTrace.push({ kind: 'index', at: performance.now(), args });
      }
      debug(...args);
    };
    const scrollTo = Element.prototype.scrollTo;
    Element.prototype.scrollTo = function (...args) {
      window.scrollOwnershipTrace.push({ kind: 'native', at: performance.now(), args, before: this.scrollTop });
      return scrollTo.apply(this, args);
    };
  });
  const evidence = {};
  const failures = [];
  const check = (condition, message) => { if (!condition) failures.push(message); };
  const open = async () => {
    await page.goto(fixtureUrl);
    await page.waitForFunction(() => window.audit?.ctrl.scrollerRef.current);
    // Let initial index navigation finish so each case owns exactly one request.
    await page.waitForTimeout(1400);
    await page.evaluate(() => { window.scrollOwnershipTrace = []; });
  };
  for (const behavior of ['auto', 'smooth']) {
    await open();
    evidence[behavior] = await page.evaluate(async behavior => {
      window.audit.ctrl.scrollToBottom(behavior);
      for (let i = 0; i < 90; i++) {
        window.audit.append('\n\nNew output ' + i + '. More content.'.repeat(8));
        await new Promise(requestAnimationFrame);
      }
      // Old native smooth completion used to replay the index after 1 second,
      // even after measured follow had taken control (and sometimes after idle).
      await new Promise(resolve => setTimeout(resolve, 1300));
      return { trace: window.scrollOwnershipTrace, state: window.audit.snapshot() };
    }, behavior);
    const { trace } = evidence[behavior];
    check(trace.filter(item => item.kind === 'native').length > 5, `${behavior}: follow was not exercised`);
    check(trace.filter(item => item.kind === 'index').length === 1, `${behavior}: old index navigation replayed after pixel follow took over`);
  }
  for (const boundary of ['suspend', 'session']) {
    await open();
    evidence[boundary] = await page.evaluate(async boundary => {
      window.audit.ctrl.scrollToMessage('h4', { behavior: 'smooth' });
      window.audit.setSpacer(300);
      await new Promise(requestAnimationFrame);
      await new Promise(requestAnimationFrame);
      if (boundary === 'suspend') window.audit.setActive(false);
      else { window.audit.setLoaded(false); window.audit.setSession('replacement'); }
      await new Promise(requestAnimationFrame);
      const boundaryAt = performance.now();
      await new Promise(resolve => setTimeout(resolve, 1400));
      return { boundaryAt, trace: window.scrollOwnershipTrace, state: window.audit.snapshot() };
    }, boundary);
    const { boundaryAt, trace } = evidence[boundary];
    check(trace.some(item => item.kind === 'index' && item.at < boundaryAt), `${boundary}: index request was not exercised`);
    check(!trace.some(item => item.kind === 'index' && item.at > boundaryAt), `${boundary}: revoked index navigation wrote after lifecycle exit`);
  }
  // A pixel command at the current offset still takes ownership: it must stop
  // native smooth motion, even if the library would normally elide a no-op.
  await open();
  evidence.sameOffset = await page.evaluate(async () => {
    // Measure the middle first. Otherwise newly mounted estimates legitimately
    // adjust scrollTop once, independently of the cancelled native animation.
    window.audit.ctrl.scrollToMessage('h10', { behavior: 'auto' });
    await new Promise(resolve => setTimeout(resolve, 300));
    window.audit.ctrl.scrollToBottom('auto');
    await new Promise(resolve => setTimeout(resolve, 300));
    window.scrollOwnershipTrace = [];
    window.audit.ctrl.scrollToMessage('h4', { behavior: 'smooth' });
    await new Promise(requestAnimationFrame);
    await new Promise(requestAnimationFrame);
    const scroller = window.audit.ctrl.scrollerRef.current;
    const top = scroller.scrollTop;
    window.audit.ctrl.virtuosoRef.current.scrollTo({ top, behavior: 'auto' });
    const frames = [];
    for (let i = 0; i < 35; i++) {
      await new Promise(requestAnimationFrame);
      frames.push(scroller.scrollTop);
    }
    return { top, frames, trace: window.scrollOwnershipTrace };
  });
  check(evidence.sameOffset.frames.every(top => Math.abs(top - evidence.sameOffset.top) <= 1),
    'same-offset pixel takeover left the older native smooth animation running');
  await writeFile(resolve(output, 'scroll-ownership.json'), JSON.stringify(evidence, null, 2));
  assert.deepEqual(failures, [], `Scroll ownership regression. Evidence: ${output}`);
  console.log(`Scroll ownership: pixel handoff, lifecycle revocation and same-offset cancellation passed. Evidence: ${output}`);
}
