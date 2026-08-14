import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  copyFileSync,
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const appVersion = JSON.parse(readFileSync(join(projectRoot, 'package.json'), 'utf8')).version;
const workerRoot = join(projectRoot, 'src-tauri', 'document-worker');
const lockPath = join(workerRoot, 'resource-lock.json');
const lock = JSON.parse(readFileSync(lockPath, 'utf8'));
const target = process.argv[2];
if (!target || !lock.targets[target]) {
  throw new Error(`Usage: node scripts/prepare-document-processing.mjs <target>; unsupported target: ${target ?? '(missing)'}`);
}
const targetLock = lock.targets[target];
const cacheRoot = join(projectRoot, 'src-tauri', 'target', 'document-processing-cache');
const extractRoot = join(cacheRoot, 'extract', target);
const resourceRoot = join(projectRoot, 'src-tauri', 'resources', 'document-processing');
const stageRoot = join(resourceRoot, `.v1-${target}.staging`);
const publishRoot = join(resourceRoot, 'v1');

mkdirSync(cacheRoot, { recursive: true });
rmSync(extractRoot, { recursive: true, force: true });
rmSync(stageRoot, { recursive: true, force: true });
mkdirSync(extractRoot, { recursive: true });
mkdirSync(join(stageRoot, 'native'), { recursive: true });
mkdirSync(join(stageRoot, 'models'), { recursive: true });
mkdirSync(join(stageRoot, 'legal'), { recursive: true });

function digestFile(path, algorithm = 'sha256', encoding = 'hex') {
  return createHash(algorithm).update(readFileSync(path)).digest(encoding);
}

async function download(entry, cacheName) {
  const destination = join(cacheRoot, cacheName);
  const valid = (path = destination) => {
    if (!existsSync(path) || statSync(path).size !== entry.size) return false;
    if (entry.sha256) return digestFile(path) === entry.sha256;
    return digestFile(path, 'sha512', 'base64') === entry.sha512Base64;
  };
  if (!valid()) {
    const temporary = `${destination}.partial`;
    rmSync(temporary, { force: true });
    let lastError;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        const response = await fetch(entry.url, { redirect: 'follow' });
        if (!response.ok || !response.body) {
          throw new Error(`Download failed (${response.status}): ${entry.url}`);
        }
        const bytes = Buffer.from(await response.arrayBuffer());
        writeFileSync(temporary, bytes, { mode: 0o600 });
        if (!valid(temporary)) throw new Error(`Locked size/digest mismatch: ${entry.url}`);
        rmSync(destination, { force: true });
        renameSync(temporary, destination);
        lastError = undefined;
        break;
      } catch (error) {
        lastError = error;
        rmSync(temporary, { force: true });
        if (attempt < 3) {
          await new Promise(resolveDelay => setTimeout(resolveDelay, attempt * 500));
        }
      }
    }
    if (lastError) {
      try {
        execFileSync('curl', [
          '--fail',
          '--location',
          '--retry', '3',
          '--retry-delay', '1',
          '--output', temporary,
          entry.url,
        ], { stdio: 'inherit' });
        if (!valid(temporary)) throw new Error(`Locked size/digest mismatch: ${entry.url}`);
        rmSync(destination, { force: true });
        renameSync(temporary, destination);
        lastError = undefined;
      } catch (error) {
        lastError = error;
        rmSync(temporary, { force: true });
      }
    }
    if (lastError) throw lastError;
  }
  if (!valid()) throw new Error(`Locked size/digest mismatch: ${entry.url}`);
  return destination;
}

function filesUnder(root) {
  const result = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) result.push(...filesUnder(path));
    else if (entry.isFile()) result.push(path);
  }
  return result;
}

function directoriesUnder(root) {
  const result = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const path = join(root, entry.name);
    result.push(path, ...directoriesUnder(path));
  }
  return result;
}

function findLockedLibrary(root, pattern) {
  const normalized = pattern.replaceAll('\\', '/');
  const regex = new RegExp(`^${normalized.split('*').map(part => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`);
  const matches = filesUnder(root).filter(path => {
    const rel = relative(root, path).replaceAll('\\', '/');
    return !rel.includes('.dSYM/') && (regex.test(rel) || regex.test(basename(path)));
  });
  if (matches.length === 1) return matches[0];
  // macOS archives contain both an unversioned loader name and the pinned
  // versioned payload. Package the versioned payload under MyAgents' stable
  // resource name; excluding dSYM contents prevents debug symbols from ever
  // being mistaken for the runtime library.
  const versioned = matches.filter(path => /(?:^|\.)1\.28\.0\.(?:dylib|so)$/.test(basename(path)));
  if (versioned.length === 1) return versioned[0];
  if (matches.length !== 1) {
    throw new Error(`Expected one ${pattern} under ${root}, found ${matches.length}: ${matches.join(', ')}`);
  }
  return matches[0];
}

async function extractArchive(entry, name) {
  const archive = await download(entry, `${target}-${name}-${basename(new URL(entry.url).pathname)}`);
  const destination = join(extractRoot, name);
  mkdirSync(destination, { recursive: true });
  execFileSync('tar', ['-xf', archive, '-C', destination], { stdio: 'inherit' });
  return destination;
}

function prepareMacX64OrtSourceBuild(entry) {
  const source = join(cacheRoot, 'onnxruntime-1.28.0-source');
  if (!existsSync(join(source, '.git'))) {
    mkdirSync(source, { recursive: true });
    execFileSync('git', ['init'], { cwd: source, stdio: 'inherit' });
    execFileSync('git', ['remote', 'add', 'origin', entry.sourceBuild.repository], { cwd: source, stdio: 'inherit' });
  }
  execFileSync('git', ['fetch', '--depth', '1', 'origin', entry.sourceBuild.commit], { cwd: source, stdio: 'inherit' });
  execFileSync('git', ['checkout', '--detach', '--force', entry.sourceBuild.commit], { cwd: source, stdio: 'inherit' });
  const actualCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: source, encoding: 'utf8' }).trim();
  if (actualCommit !== entry.sourceBuild.commit) throw new Error(`ONNX Runtime source mismatch: ${actualCommit}`);
  execFileSync('git', ['submodule', 'sync', '--recursive'], { cwd: source, stdio: 'inherit' });
  execFileSync('git', ['submodule', 'update', '--init', '--recursive', '--depth', '1'], { cwd: source, stdio: 'inherit' });
  execFileSync('./build.sh', [
    '--config', 'Release',
    '--build_shared_lib',
    '--parallel',
    '--skip_tests',
    '--cmake_extra_defines',
    'CMAKE_OSX_ARCHITECTURES=x86_64',
    'CMAKE_OSX_DEPLOYMENT_TARGET=13.0',
    'onnxruntime_BUILD_UNIT_TESTS=OFF',
  ], { cwd: source, stdio: 'inherit' });
  return source;
}

const ortExtract = targetLock.onnxRuntime.sourceBuild
  ? prepareMacX64OrtSourceBuild(targetLock.onnxRuntime)
  : await extractArchive(targetLock.onnxRuntime, 'onnxruntime');
const pdfiumExtract = await extractArchive(targetLock.pdfium, 'pdfium');
const extension = targetLock.platform === 'windows' ? '.dll' : targetLock.platform === 'macos' ? '.dylib' : '.so';
const ortDestination = join(stageRoot, 'native', `onnxruntime${extension}`);
const pdfiumDestination = join(stageRoot, 'native', `pdfium${extension}`);
copyFileSync(findLockedLibrary(ortExtract, targetLock.onnxRuntime.libraryPattern), ortDestination);
copyFileSync(findLockedLibrary(pdfiumExtract, targetLock.pdfium.libraryPattern), pdfiumDestination);

const sharedEntries = [
  ['detectorModel', 'ppocrv6-small-det.onnx'],
  ['recognizerModel', 'ppocrv6-small-rec.onnx'],
  ['dictionary', 'ppocrv6-dict.txt'],
];
const sharedPaths = {};
for (const [key, filename] of sharedEntries) {
  const cached = await download(lock.shared[key], filename);
  const destination = join(stageRoot, 'models', filename);
  copyFileSync(cached, destination);
  sharedPaths[key] = destination;
}

execFileSync('cargo', [
  'build',
  '--locked',
  '--release',
  '--target', target,
  '--manifest-path', join(workerRoot, 'Cargo.toml'),
], { cwd: projectRoot, stdio: 'inherit' });
const workerName = target.includes('windows') ? 'myagents-document-worker.exe' : 'myagents-document-worker';
const workerSource = join(workerRoot, 'target', target, 'release', workerName);
if (!existsSync(workerSource)) throw new Error(`Worker build did not produce ${workerSource}`);
copyFileSync(workerSource, join(stageRoot, workerName));
if (!target.includes('windows')) {
  const mode = statSync(join(stageRoot, workerName)).mode | 0o111;
  chmodSync(join(stageRoot, workerName), mode);
}

let nativeSigning = { kind: 'unsigned', identity: 'development-build' };
if (targetLock.platform === 'macos' && process.env.APPLE_SIGNING_IDENTITY) {
  for (const path of [ortDestination, pdfiumDestination, join(stageRoot, workerName)]) {
    execFileSync('codesign', [
      '--force',
      '--options', 'runtime',
      '--timestamp',
      '--sign', process.env.APPLE_SIGNING_IDENTITY,
      path,
    ], { stdio: 'inherit' });
    execFileSync('codesign', ['--verify', '--strict', '--verbose=2', path], { stdio: 'inherit' });
  }
  nativeSigning = {
    kind: 'codesign',
    identity: process.env.APPLE_SIGNING_IDENTITY,
  };
}

if (targetLock.platform === 'windows') {
  const signTool = process.env.WINDOWS_SIGNTOOL_PATH?.trim();
  const certificateSha1 = process.env.WINDOWS_CERTIFICATE_SHA1?.trim();
  if (Boolean(signTool) !== Boolean(certificateSha1)) {
    throw new Error('WINDOWS_SIGNTOOL_PATH and WINDOWS_CERTIFICATE_SHA1 must be set together');
  }
  if (signTool && certificateSha1) {
    const timestampUrl = process.env.WINDOWS_TIMESTAMP_URL?.trim()
      || 'http://timestamp.digicert.com';
    for (const path of [ortDestination, pdfiumDestination, join(stageRoot, workerName)]) {
      execFileSync(signTool, [
        'sign', '/fd', 'SHA256', '/sha1', certificateSha1,
        '/tr', timestampUrl, '/td', 'SHA256', path,
      ], { stdio: 'inherit' });
      execFileSync(signTool, ['verify', '/pa', '/all', path], { stdio: 'inherit' });
    }
    nativeSigning = {
      kind: 'authenticode',
      identity: certificateSha1.toLowerCase(),
    };
  }
}

if (targetLock.platform === 'linux') {
  nativeSigning = {
    kind: 'sha256-manifest',
    identity: 'MyAgents-resource-manifest-v1',
  };
}

const noticeSource = join(workerRoot, 'DOCUMENT_PROCESSING_NOTICES.md');
copyFileSync(noticeSource, join(stageRoot, 'legal', 'DOCUMENT_PROCESSING_NOTICES.md'));
copyFileSync(join(projectRoot, 'src-tauri', 'vendor', 'anydoc', 'LICENSE'), join(stageRoot, 'legal', 'ANYDOC-LICENSE'));
copyFileSync(join(projectRoot, 'src-tauri', 'vendor', 'office-crypto', 'LICENSE'), join(stageRoot, 'legal', 'OFFICE-CRYPTO-LICENSE'));
const paddleLicense = await download(lock.shared.paddleLicense, 'paddleocr-license.txt');
copyFileSync(paddleLicense, join(stageRoot, 'legal', 'PADDLEOCR-LICENSE'));
for (const [name, root] of [['ONNXRUNTIME', ortExtract], ['PDFIUM', pdfiumExtract]]) {
  const license = filesUnder(root).find(path => basename(path).toLowerCase() === 'license');
  if (!license) throw new Error(`${name} archive/source omitted LICENSE`);
  copyFileSync(license, join(stageRoot, 'legal', `${name}-LICENSE`));
  const thirdParty = filesUnder(root).find(path => basename(path).toLowerCase() === 'thirdpartynotices.txt');
  if (thirdParty) copyFileSync(thirdParty, join(stageRoot, 'legal', `${name}-ThirdPartyNotices.txt`));
}
const pdfiumLicenses = directoriesUnder(pdfiumExtract).find(path => basename(path) === 'licenses');
if (!pdfiumLicenses) throw new Error('PDFium archive omitted third-party licenses directory');
cpSync(pdfiumLicenses, join(stageRoot, 'legal', 'PDFIUM-third-party-licenses'), { recursive: true });

function resourceFile(path, license, upstreamRevision, artifactSource, signing) {
  return {
    path: relative(stageRoot, path).replaceAll('\\', '/'),
    sha256: digestFile(path),
    size: statSync(path).size,
    license,
    upstreamRevision,
    artifactSource,
    signing,
  };
}

const manifestSigning = {
  kind: 'sha256-manifest',
  identity: 'MyAgents-resource-manifest-v1',
};

const manifest = {
  schemaVersion: 1,
  pipelineVersion: lock.pipelineVersion,
  platform: targetLock.platform,
  architecture: targetLock.architecture,
  worker: resourceFile(
    join(stageRoot, workerName),
    'AGPL-3.0-only',
    `MyAgents/${appVersion}`,
    'current MyAgents source tree',
    nativeSigning,
  ),
  files: {
    onnxRuntime: resourceFile(
      ortDestination,
      targetLock.onnxRuntime.license,
      targetLock.onnxRuntime.upstreamRevision,
      targetLock.onnxRuntime.sourceBuild?.repository ?? targetLock.onnxRuntime.url,
      nativeSigning,
    ),
    pdfium: resourceFile(
      pdfiumDestination,
      targetLock.pdfium.license,
      targetLock.pdfium.upstreamRevision,
      targetLock.pdfium.url,
      nativeSigning,
    ),
    detectorModel: resourceFile(
      sharedPaths.detectorModel,
      lock.shared.detectorModel.license,
      lock.shared.detectorModel.upstreamRevision,
      lock.shared.detectorModel.url,
      manifestSigning,
    ),
    recognizerModel: resourceFile(
      sharedPaths.recognizerModel,
      lock.shared.recognizerModel.license,
      lock.shared.recognizerModel.upstreamRevision,
      lock.shared.recognizerModel.url,
      manifestSigning,
    ),
    dictionary: resourceFile(
      sharedPaths.dictionary,
      lock.shared.dictionary.license,
      lock.shared.dictionary.upstreamRevision,
      lock.shared.dictionary.url,
      manifestSigning,
    ),
  },
};
writeFileSync(join(stageRoot, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });

rmSync(publishRoot, { recursive: true, force: true });
renameSync(stageRoot, publishRoot);
console.log(`Prepared locked document-processing resources for ${target}`);
