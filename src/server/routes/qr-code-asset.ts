import { existsSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { cancellableFetch } from '../utils/cancellation';
import { ensureDirSync } from '../utils/fs-utils';

const QR_CODE_URL = 'https://download.myagents.io/assets/feedback_qr_code.png';
const CACHE_MAX_AGE_MS = 60 * 60 * 1000;
const LOCK_MAX_AGE_MS = 30_000;
const DOWNLOAD_TIMEOUT_MS = 10_000;

type FetchLike = typeof cancellableFetch;

interface QrCodeAssetRouteOptions {
  cacheDir?: string;
  cacheMaxAgeMs?: number;
  fetchImpl?: FetchLike;
  now?: () => number;
  logger?: Pick<Console, 'log' | 'warn'>;
}

interface QrCodeAssetBody {
  success: boolean;
  dataUrl?: string;
  error?: string;
}

function jsonResponse(body: QrCodeAssetBody, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.name === 'AbortError' ? '网络请求超时' : error.message;
  return String(error || '加载失败');
}

function imageMimeFromBytes(buffer: Buffer): string {
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return 'image/png';
  }
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return 'image/jpeg';
  }
  if (buffer.length >= 6 && (buffer.subarray(0, 6).toString('ascii') === 'GIF87a' || buffer.subarray(0, 6).toString('ascii') === 'GIF89a')) {
    return 'image/gif';
  }
  if (buffer.length >= 12 && buffer.subarray(0, 4).toString('ascii') === 'RIFF' && buffer.subarray(8, 12).toString('ascii') === 'WEBP') {
    return 'image/webp';
  }
  return 'application/octet-stream';
}

function readCacheDataUrl(cacheFile: string): string | null {
  try {
    if (!existsSync(cacheFile)) return null;
    const imageBuffer = readFileSync(cacheFile);
    if (imageBuffer.length === 0) return null;
    return `data:${imageMimeFromBytes(imageBuffer)};base64,${imageBuffer.toString('base64')}`;
  } catch {
    return null;
  }
}

function unavailableResponse(error: string): Response {
  return jsonResponse({ success: false, error: error || 'QR code not available' });
}

export async function handleQrCodeAssetRoute(
  pathname: string,
  request: Request,
  options: QrCodeAssetRouteOptions = {},
): Promise<Response | null> {
  if (pathname !== '/api/assets/qr-code' || request.method !== 'GET') return null;

  const cacheDir = options.cacheDir ?? join(tmpdir(), 'myagents-cache');
  const cacheFile = join(cacheDir, 'feedback_qr_code.png');
  const lockFile = `${cacheFile}.lock`;
  const cacheMaxAgeMs = options.cacheMaxAgeMs ?? CACHE_MAX_AGE_MS;
  const now = options.now ?? Date.now;
  const logger = options.logger ?? console;
  const fetchImpl = options.fetchImpl ?? cancellableFetch;
  const startTime = now();

  try {
    let needsDownload = true;
    if (existsSync(cacheFile)) {
      const age = now() - statSync(cacheFile).mtimeMs;
      if (age < cacheMaxAgeMs) {
        needsDownload = false;
        logger.log(`[api/assets/qr-code] Cache hit (age: ${Math.round(age / 1000 / 60)}min)`);
      } else {
        logger.log(`[api/assets/qr-code] Cache expired (age: ${Math.round(age / 1000 / 60)}min), re-downloading`);
      }
    } else {
      logger.log('[api/assets/qr-code] Cache miss, downloading');
    }

    if (needsDownload) {
      ensureDirSync(cacheDir);
      if (existsSync(lockFile)) {
        const lockAge = now() - statSync(lockFile).mtimeMs;
        if (lockAge < LOCK_MAX_AGE_MS) {
          logger.log('[api/assets/qr-code] Download in progress, serving available cache');
          const dataUrl = readCacheDataUrl(cacheFile);
          return dataUrl ? jsonResponse({ success: true, dataUrl }) : unavailableResponse('QR code download in progress');
        }
        rmSync(lockFile, { force: true });
      }

      writeFileSync(lockFile, String(now()));
      try {
        const downloadStartTime = now();
        const response = await fetchImpl(QR_CODE_URL, undefined, { timeoutMs: DOWNLOAD_TIMEOUT_MS });
        if (!response.ok) {
          logger.warn(`[api/assets/qr-code] Download failed (HTTP ${response.status}), using cache if available`);
        } else {
          const buffer = Buffer.from(await response.arrayBuffer());
          const tmpFile = `${cacheFile}.${now()}.tmp`;
          writeFileSync(tmpFile, buffer);
          renameSync(tmpFile, cacheFile);
          logger.log(`[api/assets/qr-code] Downloaded and cached (${Math.round(buffer.length / 1024)}KB in ${Math.round(now() - downloadStartTime)}ms)`);
        }
      } catch (error) {
        logger.warn(`[api/assets/qr-code] Download failed (${errorMessage(error)}), using cache if available`);
      } finally {
        rmSync(lockFile, { force: true });
      }
    }

    const dataUrl = readCacheDataUrl(cacheFile);
    if (!dataUrl) return unavailableResponse('QR code not available');

    logger.log(`[api/assets/qr-code] Request completed in ${Math.round(now() - startTime)}ms`);
    return jsonResponse({ success: true, dataUrl });
  } catch (error) {
    logger.warn(`[api/assets/qr-code] Optional asset route failed (${errorMessage(error)})`);
    const dataUrl = readCacheDataUrl(cacheFile);
    return dataUrl ? jsonResponse({ success: true, dataUrl }) : unavailableResponse(errorMessage(error));
  }
}
