/* global window */
import { invoke } from '@tauri-apps/api/core';
import { listen, once, emit, emitTo } from '@tauri-apps/api/event';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { getCurrentWebview } from '@tauri-apps/api/webview';
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow';
import { listenWithCleanup } from '../../../src/renderer/utils/tauriListen';

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const failures = [], samples = [];
window.addEventListener('error', event => failures.push(String(event.error ?? event.message)));
window.addEventListener('unhandledrejection', event => failures.push(String(event.reason)));
const assert = (condition, message) => { if (!condition) throw new Error(message); };
const state = () => {
  const registry = window.__internal_unstable_listeners_object_id__ ?? {};
  const tables = Object.getOwnPropertyNames(registry);
  return { callbacks: window.__TAURI_INTERNALS__.callbacks.size, tables: tables.length,
    descriptors: tables.reduce((n, event) => n + Object.getOwnPropertyNames(registry[event]).length, 0) };
};
async function until(condition) {
  const end = Date.now() + 5000;
  while (!condition()) { assert(Date.now() < end, 'native event delivery deadline'); await pause(5); }
}
async function checkpoint(phase) {
  // Let actual asynchronous native unlisten and queued events finish before sampling.
  await pause(100);
  const counts = state();
  samples.push({ phase, ...counts, failures: [...failures] });
  await invoke('report', { value: samples.at(-1) });
  assert(counts.callbacks === 0 && counts.tables === 0 && counts.descriptors === 0, `${phase}: leaked ${JSON.stringify(counts)}`);
  assert(failures.length === 0, `${phase}: ${failures.join('; ')}`);
}

(async () => {
  let late = 0;
  for (let i = 0; i < 10000; i++) await (await listen('sequential', () => late++))();
  await emit('sequential', null);
  await checkpoint('10000 sequential cancellations');
  for (let batch = 0; batch < 100; batch++) {
    await Promise.all(Array.from({ length: 100 }, async () => { const off = await listen('burst', () => late++); await off(); }));
  }
  await emit('burst', null);
  await checkpoint('10000 burst cancellations');
  assert(late === 0, 'cancelled listener received an event');

  for (let i = 0; i < 1000; i++) await (await listen(`session-${i}`, () => late++))();
  await checkpoint('1000 distinct event names');
  for (let i = 0; i < 100; i++) {
    let rejected = false;
    try { await listen('invalid event name', () => late++); } catch { rejected = true; }
    assert(rejected, 'invalid event name was accepted');
  }
  await checkpoint('100 registration rejections');

  let onceCalls = 0;
  for (let i = 0; i < 100; i++) {
    const off = await once('consume-once', () => onceCalls++);
    await emit('consume-once', null);
    await until(() => onceCalls === i + 1);
    await emit('consume-once', null);
    await off();
  }
  assert(onceCalls === 100, 'once handler delivered more than once');
  await checkpoint('100 once completions and repeated cleanup');

  for (let batch = 0; batch < 10; batch++) {
    await Promise.all(Array.from({ length: 100 }, async () => {
      const controller = new AbortController();
      const pending = listenWithCleanup('aborted', () => late++, controller.signal);
      controller.abort();
      const result = await pending;
      assert(!result.isRegistered(), 'aborted helper still reports registration');
    }));
  }
  await emit('aborted', null);
  await checkpoint('1000 actual helper aborts during registration');
  assert(late === 0, 'aborted helper invoked user callback');

  for (const [kind, target] of [['Window', getCurrentWindow()], ['Webview', getCurrentWebview()], ['WebviewWindow', getCurrentWebviewWindow()]]) {
    let calls = 0;
    const off = await target.listen('target', () => calls++);
    await emitTo({ kind, label: 'main' }, 'target', null);
    await until(() => calls === 1);
    await off();
    await emitTo({ kind, label: 'main' }, 'target', null);
    await checkpoint(`${kind} target`);
    assert(calls === 1, `${kind} delivered after cancellation`);
  }
  await invoke('done', { value: { success: true, samples, onceCalls, late, failures } });
})().catch(async error => { await invoke('done', { value: { success: false, error: String(error), samples, failures, state: state() } }); });
