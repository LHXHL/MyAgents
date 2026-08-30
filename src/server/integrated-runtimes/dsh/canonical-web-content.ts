import DOMMatrixShim from '@thednp/dommatrix';
import TurndownService from 'turndown';

import { DshCanonicalWebError } from './canonical-web-errors';

const MAX_CONVERTED_BYTES = 200_000;
const MAX_PDF_PAGES = 512;

const htmlConverter = new TurndownService({
  bulletListMarker: '-',
  codeBlockStyle: 'fenced',
  emDelimiter: '_',
  headingStyle: 'atx',
  strongDelimiter: '**',
});
htmlConverter.remove([
  'audio', 'canvas', 'embed', 'form', 'iframe', 'noscript', 'object', 'script',
  'style', 'template', 'video',
]);

export function truncateDshWebText(
  value: string,
  maxBytes = MAX_CONVERTED_BYTES,
): Readonly<{ text: string; truncated: boolean }> {
  const bytes = Buffer.from(value, 'utf8');
  if (bytes.byteLength <= maxBytes) return Object.freeze({ text: value, truncated: false });
  let end = maxBytes;
  while (end > 0 && (bytes[end] ?? 0) >= 0x80 && (bytes[end] ?? 0) < 0xc0) end -= 1;
  return Object.freeze({ text: bytes.subarray(0, end).toString('utf8'), truncated: true });
}

async function extractPdfText(
  bytes: Uint8Array,
  signal: AbortSignal,
): Promise<Readonly<{ text: string; truncated: boolean }>> {
  signal.throwIfAborted();
  globalThis.DOMMatrix ??= DOMMatrixShim as unknown as typeof DOMMatrix;
  const workerGlobal = globalThis as typeof globalThis & { pdfjsWorker?: unknown };
  workerGlobal.pdfjsWorker ??= await import('pdfjs-dist/legacy/build/pdf.worker.mjs');
  const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
  signal.throwIfAborted();
  const loadingTask = getDocument({
    data: Uint8Array.from(bytes),
    disableFontFace: true,
    stopAtErrors: false,
    useSystemFonts: false,
    useWorkerFetch: false,
  });
  const destroy = (): Promise<void> => loadingTask.destroy();
  let abortCleanup: Promise<void> | undefined;
  const abort = (): void => {
    abortCleanup ??= destroy();
  };
  signal.addEventListener('abort', abort, { once: true });
  if (signal.aborted) abort();
  try {
    const document = await loadingTask.promise;
    signal.throwIfAborted();
    const pageLimit = Math.min(document.numPages, MAX_PDF_PAGES);
    let text = '';
    let truncated = document.numPages > pageLimit;
    for (let pageNumber = 1; pageNumber <= pageLimit; pageNumber += 1) {
      signal.throwIfAborted();
      const page = await document.getPage(pageNumber);
      try {
        const content = await page.getTextContent();
        const pageText = content.items.map((item) => (
          'str' in item ? `${item.str}${item.hasEOL ? '\n' : ' '}` : ''
        )).join('').trim();
        const bounded = truncateDshWebText(`${text}${text ? '\n\n' : ''}${pageText}`);
        text = bounded.text;
        if (bounded.truncated) {
          truncated = true;
          break;
        }
      } finally {
        page.cleanup();
      }
    }
    if (!text.trim()) {
      throw new DshCanonicalWebError('unsupported_content', 'WebFetch PDF has no extractable text');
    }
    return Object.freeze({ text, truncated });
  } catch (error) {
    if (signal.aborted) throw signal.reason;
    if (error instanceof DshCanonicalWebError) throw error;
    throw new DshCanonicalWebError('unsupported_content', 'WebFetch PDF conversion failed', { cause: error });
  } finally {
    signal.removeEventListener('abort', abort);
    await (abortCleanup ?? destroy()).catch(() => undefined);
    if (signal.aborted) signal.throwIfAborted();
  }
}

export async function convertDshWebContent(input: {
  bytes: Uint8Array;
  contentType: string;
  signal: AbortSignal;
}): Promise<Readonly<{ text: string; truncated: boolean }>> {
  input.signal.throwIfAborted();
  if (input.contentType === 'application/pdf') {
    return await extractPdfText(input.bytes, input.signal);
  }
  const supportedText = input.contentType === 'text/html'
    || input.contentType === 'text/plain'
    || input.contentType === 'text/markdown'
    || input.contentType === 'application/xhtml+xml'
    || input.contentType === 'application/json'
    || input.contentType.endsWith('+json');
  if (!supportedText) {
    throw new DshCanonicalWebError('unsupported_content', 'WebFetch response content type is unsupported');
  }
  const decoded = truncateDshWebText(new TextDecoder('utf-8', { fatal: false }).decode(input.bytes));
  input.signal.throwIfAborted();
  if (input.contentType !== 'text/html' && input.contentType !== 'application/xhtml+xml') {
    return decoded;
  }
  try {
    const converted = truncateDshWebText(htmlConverter.turndown(decoded.text));
    return Object.freeze({
      text: converted.text,
      truncated: decoded.truncated || converted.truncated,
    });
  } catch (error) {
    throw new DshCanonicalWebError('unsupported_content', 'WebFetch HTML conversion failed', { cause: error });
  }
}
