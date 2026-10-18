// Keep this paired with vendor/tauri: callback allocation and native descriptor
// installation must share the same cancellation contract. Remove the pair only
// when an upstream version passes tauri-event-lifecycle.test.mjs and native smoke.
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repair = JSON.parse(readFileSync(new URL('./patches/tauri-events.json', import.meta.url), 'utf8'));
const upstream = JSON.parse(readFileSync(new URL('../vendor/tauri/UPSTREAM_FILES.json', import.meta.url), 'utf8'));
const digest = source => createHash('sha256').update(source).digest('hex');

export function repairVendoredTauri(directory, check = false) {
  const pending = [];
  for (const [name, original] of Object.entries(upstream)) {
    const path = resolve(directory, name);
    const source = readFileSync(path);
    const expected = name === repair.nativeFile ? repair.nativeSha256 : original;
    if (digest(source) === expected) continue;

    // Older Windows checkouts may have converted the exact committed bytes to
    // CRLF before vendor/tauri/** was marked -text. Restore only proven EOL drift.
    const restored = Buffer.from(source.toString('utf8').replaceAll('\r\n', '\n'));
    if (digest(restored) !== expected) {
      throw new Error(`Unexpected vendored Tauri bytes: ${name}. Review vendor/tauri before building.`);
    }
    if (check) throw new Error('Vendored Tauri checkout has CRLF conversion. Run npm run postinstall to restore its verified bytes.');
    pending.push({ path, restored });
  }
  for (const { path, restored } of pending) writeFileSync(path, restored);
}

export function patchTauriEvents(directory, check = false) {
  const metadata = JSON.parse(readFileSync(resolve(directory, 'package.json'), 'utf8'));
  if (metadata.name !== '@tauri-apps/api' || metadata.version !== repair.apiVersion) {
    throw new Error(`Tauri event lifetime repair requires @tauri-apps/api ${repair.apiVersion}. Review the native and JS regressions before upgrading.`);
  }
  const vendor = resolve(import.meta.dirname, '../vendor/tauri');
  repairVendoredTauri(vendor, check);
  const native = resolve(vendor, repair.nativeFile);
  if (digest(readFileSync(native)) !== repair.nativeSha256) {
    throw new Error('Tauri native event lifetime patch does not match its JS counterpart. Review vendor/tauri before building.');
  }
  const pending = Object.entries(repair.files).flatMap(([name, patch]) => {
    const path = resolve(directory, name), source = readFileSync(path, 'utf8');
    if (digest(source) === patch.repaired) return [];
    if (digest(source) !== patch.original) throw new Error(`Unexpected Tauri API bytes: ${name}`);
    if (check) throw new Error('Tauri event lifetime repair is missing. Run npm run postinstall.');
    const result = source.replace(patch.from, patch.to);
    if (digest(result) !== patch.repaired) throw new Error(`Tauri event lifetime repair mismatch: ${name}`);
    return [{ path, result }];
  });
  for (const { path, result } of pending) writeFileSync(path, result);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  patchTauriEvents(resolve(import.meta.dirname, '../node_modules/@tauri-apps/api'), process.argv.includes('--check'));
}
