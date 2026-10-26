import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { installPluginAdmissionRuntimeGlobals, markCurrentPluginInboundAccepted } from './lark-admission';
import { patchImMonitorAdmissionSource } from './plugin-compat-patches';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

describe('installed IM monitor admission contracts', () => {
  for (const kind of ['weixin', 'qq'] as const) {
    it(`${kind}: the next input enters before the previous renderer completes`, async () => {
      const filename = kind === 'weixin' ? 'weixin-monitor' : 'qq-gateway';
      const original = gunzipSync(readFileSync(new URL(`./fixtures/${filename}.ts.gz`, import.meta.url))).toString();
      const source = `// Upgraded monitor build\n${original}\nexport const buildLabel = 'next';`
        .replaceAll('    ', '\t').replaceAll('\n', '\r\n');
      const patched = patchImMonitorAdmissionSource(source, kind);
      expect(patched).not.toBeNull();
      expect(patchImMonitorAdmissionSource(source.replaceAll(
        kind === 'weixin' ? 'processOneMessage(full,' : 'handleMessageFnRef(msg)',
        'changedMessageHandler()',
      ), kind)).toBeNull();
      // Execute the exact transformed admission boundary from the pinned
      // upstream source. No accounts, user state, network or vendor API calls.
      const start = patched!.indexOf('const admit = (globalThis as any).__myagentsAwaitPluginAdmission;');
      const tail = kind === 'weixin' ? /\s+}\s+}\s+catch/ : /\s+messagesProcessed\+\+;/;
      const end = start + patched!.slice(start).search(tail);
      expect(start).toBeGreaterThan(0);
      expect(end).toBeGreaterThan(start);
      const code = ts.transpileModule(patched!.slice(start, end), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
      const call = new Function('handle', 'message', `
        const processOneMessage = handle, handleMessageFnRef = handle, full = message, msg = message;
        const accountId = 'account', config = {}, channelRuntime = {}, baseUrl = '', cdnBaseUrl = '', token = '';
        const cachedConfig = {}, opts = {}, errLog = () => {}, log = { error() {} };
        return (async () => { ${code} })();
      `) as (handle: (message: string) => Promise<void>, message: string) => Promise<void>;
      installPluginAdmissionRuntimeGlobals();
      const first = deferred();
      const second = deferred();
      const finished = deferred();
      const entered: string[] = [];
      const completed: string[] = [];
      const handle = async (message: string) => {
        entered.push(message);
        expect(markCurrentPluginInboundAccepted()).toBe(true);
        await (message === 'first' ? first : second).promise;
        completed.push(message);
        if (completed.length === 2) finished.resolve();
      };
      await call(handle, 'first');
      await call(handle, 'second');
      expect(entered).toEqual(['first', 'second']);
      expect(completed).toEqual([]);
      second.resolve();
      first.resolve();
      await finished.promise;
      expect(completed).toEqual(['second', 'first']);
    });
  }
});
