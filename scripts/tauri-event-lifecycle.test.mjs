import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { test } from 'node:test';
import vm from 'node:vm';

const nativeSource = readFileSync(resolve(import.meta.dirname, '../vendor/tauri/src/event/mod.rs'), 'utf8');
const api = await import('@tauri-apps/api/event');
const cjs = createRequire(import.meta.url)('@tauri-apps/api/event');
const registry = '__internal_unstable_listeners_object_id__';
const dispatch = '__internal_unstable_listeners_function_id__';

// Execute the dependency's actual generated JS, with explicit control over when
// the native eval reaches the WebView. No sleeps and no copy of the repair logic.
function script(name, values) {
  const source = nativeSource.slice(nativeSource.indexOf(`pub(crate) fn ${name}(`));
  const literal = /format!\(\s*"((?:\\.|[^"\\])*)"/s.exec(source)?.[1];
  assert.ok(literal, `missing Rust JS template ${name}`);
  const decoded = JSON.parse(`"${literal.replaceAll('\n', '\\n')}"`);
  return decoded.replace(/\{\{|\}\}|\{(\w+)\}/g, (match, key) => {
    if (match === '{{') return '{';
    if (match === '}}') return '}';
    assert.ok(Object.hasOwn(values, key), `missing template argument ${key}`);
    return values[key];
  });
}

function fixture({ delayed = false, reject = false } = {}) {
  let nextCallback = 100, nextEvent = 1;
  const callbacks = new Map(), recipients = new Map(), pending = [], missingCallbacks = [];
  const window = { __TAURI_INTERNALS__: {
    callbacks,
    transformCallback(handler) { const id = nextCallback++; callbacks.set(id, handler); return id; },
    unregisterCallback(id) { callbacks.delete(id); },
    runCallback(id, event) { const handler = callbacks.get(id); if (handler) handler(event); else missingCallbacks.push(id); },
    async invoke(command, args) {
      if (command === 'plugin:event|listen') {
        if (reject) throw new Error('synthetic native registration rejection');
        const id = nextEvent++;
        recipients.set(id, args);
        const install = script('listen_js_script', { listeners_object_name: registry, serialized_target: JSON.stringify(args.target), event: args.event, event_id: id, handler_id: args.handler });
        if (delayed) pending.push(install); else run(install);
        return id;
      }
      assert.equal(command, 'plugin:event|unlisten');
      recipients.delete(args.eventId);
    },
  } };
  const context = vm.createContext({ window });
  const run = source => vm.runInContext(source, context);
  run(script('event_initialization_script', { function_name: dispatch, listeners: registry }));
  window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener(event, eventId) {
    run(script('unlisten_js_script', { listeners_object_name: registry, event_arg: JSON.stringify(event), event_id_arg: eventId }));
  } };
  globalThis.window = window;
  const ids = event => [...recipients].filter(([, args]) => args.event === event).map(([id]) => id);
  return {
    window, callbacks, recipients, missingCallbacks,
    flush() { for (const source of pending.splice(0)) run(source); },
    emit(event, selected = ids(event)) { window[dispatch]({ event, payload: 'synthetic' }, selected); },
    ids,
    assertEmpty() {
      assert.equal(callbacks.size, 0, 'event callback retained');
      assert.equal(recipients.size, 0, 'native recipient retained');
      assert.equal(Object.getOwnPropertyNames(window[registry] ?? {}).length, 0, 'event metadata retained');
      assert.deepEqual(missingCallbacks, [], 'queued dispatch accessed a released callback');
    },
  };
}

for (const [format, events] of [['esm', api], ['cjs', cjs]]) {
  test(`${format}: ordinary unlisten releases all resources and is idempotent`, async () => {
    const f = fixture(); let calls = 0;
    const off = await events.listen('same-event', () => calls++);
    const queued = f.ids('same-event');
    f.emit('same-event'); assert.equal(calls, 1);
    await off(); await off();
    f.emit('same-event', queued); assert.equal(calls, 1);
    f.assertEmpty();
  });

  for (const existingTable of [false, true]) test(`${format}: cancellation before install, existing table=${existingTable}`, async () => {
    const f = fixture({ delayed: true }); let calls = 0;
    const keep = existingTable ? await events.listen('race', () => calls++) : null;
    if (keep) f.flush();
    const cleanups = await Promise.all(Array.from({ length: 100 }, () => events.listen('race', () => calls++)));
    const queued = f.ids('race');
    await Promise.all(cleanups.map(off => off()));
    f.flush();
    if (keep) await keep();
    f.emit('race', queued);
    assert.equal(calls, 0);
    f.assertEmpty();
  });

  test(`${format}: deferred install still delivers active listeners`, async () => {
    const f = fixture({ delayed: true }); let calls = 0;
    const off = await events.listen('active', () => calls++);
    f.flush(); f.emit('active'); assert.equal(calls, 1);
    await off(); f.assertEmpty();
  });

  test(`${format}: native registration rejection releases allocated callback`, async () => {
    const f = fixture({ reject: true });
    await assert.rejects(events.listen('rejected', () => {}), /registration rejection/);
    await assert.rejects(events.once('rejected-once', () => {}), /registration rejection/);
    f.flush(); f.assertEmpty();
  });

  test(`${format}: once is consumed before reentrant user code and late dispatch`, async () => {
    const f = fixture(); let calls = 0;
    const off = await events.once('once', () => { calls++; f.emit('once', [1]); });
    f.emit('once'); f.emit('once', [1]);
    assert.equal(calls, 1);
    await off(); f.assertEmpty();
  });

  test(`${format}: once can be cancelled before descriptor installation`, async () => {
    const f = fixture({ delayed: true }); let calls = 0;
    const off = await events.once('cancel-once', () => calls++);
    await off(); f.flush(); f.emit('cancel-once', [1]);
    assert.equal(calls, 0); f.assertEmpty();
  });

  test(`${format}: throwing once handler still releases its resources first`, async () => {
    const f = fixture();
    const off = await events.once('throwing-once', () => { throw new Error('user handler failed'); });
    assert.throws(() => f.emit('throwing-once'), /user handler failed/);
    f.emit('throwing-once', [1]);
    await off(); f.assertEmpty();
  });

  test(`${format}: cancelling one listener preserves a live sibling`, async () => {
    const f = fixture(); let calls = 0;
    const off = await events.listen('shared', () => { throw new Error('cancelled sibling invoked'); });
    const keep = await events.listen('shared', () => calls++);
    await off(); f.emit('shared', [1, 2]);
    assert.equal(calls, 1);
    await keep(); f.assertEmpty();
  });

  test(`${format}: distinct event names do not retain empty tables`, async () => {
    const f = fixture();
    for (let i = 0; i < 1000; i++) await (await events.listen(`session-${i}`, () => {}))();
    f.assertEmpty();
  });

  test(`${format}: event target normalization and matching metadata are preserved`, async () => {
    const f = fixture();
    for (const target of [undefined, 'main', { kind: 'Window', label: 'main' }, { kind: 'Webview', label: 'child' }, { kind: 'WebviewWindow', label: 'other' }]) {
      const off = await events.listen('targeted', () => {}, { target });
      const expected = typeof target === 'string' ? { kind: 'AnyLabel', label: target } : target ?? { kind: 'Any' };
      assert.deepEqual([...f.recipients.values()][0].target, expected);
      assert.equal(JSON.stringify(Object.getOwnPropertyDescriptors(f.window[registry].targeted)[f.ids('targeted')[0]].value.target), JSON.stringify(expected));
      await off();
    }
    f.assertEmpty();
  });
}
