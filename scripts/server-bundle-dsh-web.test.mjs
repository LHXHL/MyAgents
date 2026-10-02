import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';

import { build } from 'esbuild';

const repoRoot = resolve(import.meta.dirname, '..');

test('the bundled DSH transport passes frozen page and Provider headers through real ProxyAgent', { timeout: 15_000 }, async () => {
  const scratch = await mkdtemp(join(tmpdir(), 'myagents-dsh-proxy-bundle-'));
  const outfile = join(scratch, 'safe-http.mjs');
  const sockets = new Set();
  const received = [];
  const tunneled = createServer(async (request, response) => {
    let body = '';
    for await (const chunk of request) body += chunk.toString();
    received.push({ headers: request.headers, method: request.method, body });
    response.end('synthetic response');
  });
  const proxy = createServer();
  let connects = 0;
  let transport;
  try {
    await build({
      absWorkingDir: repoRoot,
      entryPoints: ['src/server/integrated-runtimes/dsh/safe-http.ts'], outfile,
      bundle: true, platform: 'node', target: 'node22', format: 'esm',
      banner: { js: 'import { createRequire as __myAgentsCreateRequire } from "module"; const require = __myAgentsCreateRequire(import.meta.url);' },
    });
    const module = await import(pathToFileURL(outfile));
    transport = new module.DshNodeProxyHttpTransport(4096);
    proxy.on('connect', (_request, socket) => {
      connects += 1;
      sockets.add(socket);
      socket.once('close', () => sockets.delete(socket));
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      tunneled.emit('connection', socket);
    });
    await new Promise(resolveListen => proxy.listen(0, '127.0.0.1', resolveListen));
    const address = proxy.address();
    assert.ok(address && typeof address !== 'string');
    const proxyUrl = `http://127.0.0.1:${address.port}`;
    const headers = [
      Object.freeze({ accept: 'text/html' }),
      Object.freeze({ authorization: 'Bearer synthetic-a', 'content-type': 'application/json' }),
      Object.freeze({ 'x-api-key': 'synthetic-b', 'anthropic-version': '2023-06-01', 'content-type': 'application/json' }),
    ];
    const original = JSON.stringify(headers);
    for (let repeat = 0; repeat < 2; repeat += 1) {
      const responses = await Promise.all(headers.map((entry, index) => transport.dispatch(
        new URL(`http://127.0.0.${index + 2}/fixture`),
        { method: index === 0 ? 'GET' : 'POST', headers: entry, ...(index ? { body: Buffer.from('{}') } : {}) },
        AbortSignal.timeout(5000), proxyUrl,
      )));
      assert.deepEqual(responses.map(response => Buffer.from(response.bytes).toString()), Array(3).fill('synthetic response'));
    }
    assert.equal(JSON.stringify(headers), original);
    assert.ok(headers.every(entry => !Object.hasOwn(entry, 'host')));
    assert.equal(received.length, 6);
    for (const entry of received) {
      const index = Number(entry.headers.host.split('.').at(-1)) - 2;
      assert.equal(entry.headers.authorization ?? entry.headers['x-api-key'] ?? '', ['', 'Bearer synthetic-a', 'synthetic-b'][index]);
      assert.equal(entry.body, index === 0 ? '' : '{}');
    }
    const previousConnects = connects;
    await assert.rejects(transport.dispatch(new URL('http://127.0.0.7/fixture'), {
      method: 'POST', headers: Object.freeze({ 'invalid header': 'synthetic' }), body: Buffer.from('{}'),
    }, AbortSignal.timeout(5000), proxyUrl), { code: 'web_request_failed', phase: 'request_construction' });
    assert.equal(connects, previousConnects);
    await transport.close();
    await assert.rejects(transport.dispatch(new URL('http://127.0.0.7/fixture'), {
      method: 'GET', headers: headers[0],
    }, AbortSignal.timeout(5000), proxyUrl), { code: 'web_request_failed' });
  } finally {
    await transport?.close();
    for (const socket of sockets) socket.destroy();
    await new Promise(resolveClose => proxy.close(resolveClose));
    tunneled.close();
    await rm(scratch, { recursive: true, force: true });
  }
});

function minimalPdf(text) {
  const escaped = text.replaceAll('\\', '\\\\').replaceAll('(', '\\(').replaceAll(')', '\\)');
  const stream = `BT /F1 12 Tf 72 100 Td (${escaped}) Tj ET`;
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 144] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let source = '%PDF-1.4\n';
  const offsets = [0];
  for (const [index, item] of objects.entries()) {
    offsets.push(Buffer.byteLength(source));
    source += `${index + 1} 0 obj\n${item}\nendobj\n`;
  }
  const xref = Buffer.byteLength(source);
  source += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  source += offsets.slice(1).map(
    offset => `${String(offset).padStart(10, '0')} 00000 n \n`,
  ).join('');
  source += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(source, 'ascii');
}

test('the bundled DSH Host Web converter keeps its worker and pure-JS PDF matrix support', async () => {
  const scratch = await mkdtemp(join(tmpdir(), 'myagents-dsh-web-bundle-'));
  const outfile = join(scratch, 'canonical-web-content.mjs');
  const originalWarn = console.warn;
  try {
    await build({
      absWorkingDir: repoRoot,
      entryPoints: ['src/server/integrated-runtimes/dsh/canonical-web-content.ts'],
      outfile,
      bundle: true,
      platform: 'node',
      target: 'node22',
      format: 'esm',
    });
    console.warn = () => undefined;
    const module = await import(pathToFileURL(outfile));
    const result = await module.convertDshWebContent({
      bytes: minimalPdf('Hello bundled canonical PDF'),
      contentType: 'application/pdf',
      signal: new AbortController().signal,
    });
    assert.deepEqual(result, { text: 'Hello bundled canonical PDF', truncated: false });
  } finally {
    console.warn = originalWarn;
    await rm(scratch, { recursive: true, force: true });
  }
});
