import { describe, expect, it } from 'vitest';

import { convertDshWebContent, truncateDshWebText } from './canonical-web-content';

function minimalPdf(text: string): Uint8Array {
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
  source += offsets.slice(1)
    .map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`)
    .join('');
  source += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(source, 'ascii');
}

describe('canonical Host WebFetch content conversion', () => {
  it('extracts bounded PDF text without network or render authority', async () => {
    await expect(convertDshWebContent({
      bytes: minimalPdf('Hello governed PDF'),
      contentType: 'application/pdf',
      signal: new AbortController().signal,
    })).resolves.toEqual({ text: 'Hello governed PDF', truncated: false });
  });

  it('removes active HTML and truncates on a UTF-8 boundary', async () => {
    await expect(convertDshWebContent({
      bytes: Buffer.from('<h1>Title</h1><script>ignore()</script><p>Hello <strong>world</strong>.</p>'),
      contentType: 'text/html',
      signal: new AbortController().signal,
    })).resolves.toEqual({ text: '# Title\n\nHello **world**.', truncated: false });

    expect(truncateDshWebText('你好世界', 7)).toEqual({ text: '你好', truncated: true });
  });
});
