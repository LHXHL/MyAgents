import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';

import { build } from 'esbuild';

const repoRoot = resolve(import.meta.dirname, '..');

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
