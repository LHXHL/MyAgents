import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';

const repo = resolve(import.meta.dirname, '..');
const hooksPath = join(repo, 'src-tauri/nsis/hooks.nsh');
const hooks = readFileSync(hooksPath, 'utf8');
const template = readFileSync(join(repo, 'src-tauri/nsis/installer.nsi'), 'utf8');
const cleanupMacro = '_MYAGENTS_REMOVE_NODE_RUNTIME';
const compiler = process.env.MYAGENTS_TEST_MAKENSIS || 'makensis';
const hasCompiler = spawnSync(compiler, [process.platform === 'win32' ? '/VERSION' : '-VERSION']).status === 0;
if (process.env.MYAGENTS_TEST_MAKENSIS && !hasCompiler) throw new Error('Requested NSIS compiler is unavailable');
const nsisQuote = value => value.replaceAll('$', '$$').replaceAll('"', '$\\"');

function put(path, source) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, source);
}
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'myagents-node-install-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}
function npmTree(root) {
  // Minimal offline CommonJS packages preserving the issue's export shapes
  // and lookup boundaries. A legitimate v3 dependency remains in the new tree.
  const modules = join(root, 'node_modules/npm/node_modules');
  put(join(modules, 'minipass/index.js'), 'exports.Minipass = class Minipass {};');
  put(join(modules, 'minipass-flush/index.js'), "const { Minipass } = require('minipass'); module.exports = class Flush extends Minipass {};");
  put(join(modules, 'cacache/index.js'), "module.exports = require('minipass-flush');");
  put(join(modules, 'minipass-pipeline/index.js'), "const Minipass = require('minipass'); module.exports = class Pipeline extends Minipass {};");
  put(join(modules, 'minipass-pipeline/node_modules/minipass/index.js'), 'module.exports = class Minipass {};');
  return modules;
}
function probe(modules, name = 'cacache') {
  return spawnSync(process.execPath, ['-e', 'require(process.argv[1])', join(modules, name)], { encoding: 'utf8' });
}
function runNsis(executable, args) {
  // NSIS /D= and _?= require an unquoted final command-line tail, even for
  // paths containing spaces. Quote only argv[0], leaving those tails verbatim.
  return spawnSync(executable, args, {
    timeout: 15_000,
    windowsVerbatimArguments: true,
    argv0: `"${executable}"`,
  });
}
function compileFixture(t) {
  const root = fixture(t);
  const payload = join(root, 'payload');
  npmTree(payload);
  const installer = join(root, 'setup.exe');
  const script = join(root, 'fixture.nsi');
  put(script, `
Unicode true
Name "Node runtime replacement fixture"
OutFile "${nsisQuote(installer)}"
InstallDir "${nsisQuote(join(root, 'default-install'))}"
RequestExecutionLevel user
SilentInstall silent
SilentUnInstall silent
!include "${nsisQuote(hooksPath)}"
Section Install
  SetOutPath $INSTDIR
  !insertmacro ${cleanupMacro}
  SetOutPath "$INSTDIR\\nodejs"
  File /r "${nsisQuote(payload)}/*"
  SetOutPath $INSTDIR
  FileOpen $0 "$INSTDIR\\installed.marker" w
  FileClose $0
  WriteUninstaller "$INSTDIR\\uninstall.exe"
SectionEnd
Section Uninstall
  SetOutPath $INSTDIR
  !insertmacro ${cleanupMacro}
SectionEnd
`);
  const result = spawnSync(compiler, [process.platform === 'win32' ? '/V2' : '-V2', script], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.ok(existsSync(installer));
  return { root, installer };
}

test('NSIS install and uninstall clean the complete app-owned Node tree after quiescence', () => {
  for (const name of ['NSIS_HOOK_PREINSTALL', 'NSIS_HOOK_PREUNINSTALL']) {
    const body = hooks.match(new RegExp(`!macro ${name}\\n([\\s\\S]*?)!macroend`))?.[1];
    assert.ok(body);
    assert.ok(body.includes(`!insertmacro ${cleanupMacro}`), `${name} must remove obsolete runtime dependencies`);
    const quiesceAt = body.indexOf('_MYAGENTS_KILL_PROCESSES');
    assert.ok(quiesceAt >= 0 && quiesceAt < body.indexOf(cleanupMacro));
  }
  const install = template.slice(template.indexOf('Section Install'), template.indexOf('; Copy external binaries'));
  const hookAt = install.indexOf('!insertmacro NSIS_HOOK_PREINSTALL');
  const copyAt = install.indexOf('; Copy resources');
  assert.ok(hookAt >= 0 && copyAt >= 0 && hookAt < copyAt);
  const windows = JSON.parse(readFileSync(join(repo, 'src-tauri/tauri.windows.conf.json')));
  assert.equal(windows.bundle.windows.nsis.installerHooks, 'nsis/hooks.nsh');
  const bundle = JSON.parse(readFileSync(join(repo, 'src-tauri/tauri.conf.json'))).bundle;
  assert.equal(bundle.resources['../src-tauri/resources/nodejs'], 'nodejs');
});

test('runtime cleanup stops on deletion failure and cannot defer deletion until reboot', () => {
  const body = hooks.match(new RegExp(`!macro ${cleanupMacro}\\n([\\s\\S]*?)!macroend`))?.[1];
  assert.ok(body, 'the installer must own full runtime replacement');
  assert.match(body, /ClearErrors[\s\S]*RMDir \/r "\$INSTDIR\\nodejs"[\s\S]*IfErrors/);
  assert.match(body, /SetErrorLevel 2[\s\S]*Abort/);
  assert.doesNotMatch(body, /REBOOTOK|\$PROFILE|\.myagents|RMDir \/r "\$INSTDIR"/);
});

test('offline reconstruction: overlay retains a nested dependency that shadows the valid new export', t => {
  const root = fixture(t);
  const old = join(root, 'installed/nodejs');
  const stale = join(old, 'node_modules/npm/node_modules/minipass-flush/node_modules/minipass/index.js');
  put(stale, 'module.exports = class Minipass {};');
  const payload = join(root, 'new-release');
  npmTree(payload);
  cpSync(payload, old, { recursive: true });

  const modules = join(old, 'node_modules/npm/node_modules');
  assert.match(probe(modules).stderr, /Class extends value undefined/);
  assert.equal(probe(modules, 'minipass-pipeline').status, 0, 'legitimate old dependencies must remain in the new distribution');
  assert.equal(probe(join(payload, 'node_modules/npm/node_modules')).status, 0, 'the fresh distribution is independently usable');
});

test('real NSIS compiler accepts the production cleanup in install and uninstall sections', { skip: !hasCompiler }, t => {
  compileFixture(t);
});

test('Windows NSIS replaces stale dependencies on upgrade/reinstall and cleans them on uninstall', { skip: process.platform !== 'win32' || !hasCompiler }, t => {
  const { root, installer } = compileFixture(t);
  const target = join(root, '安装 path');
  const unrelated = join(target, 'user-note.txt');
  put(unrelated, 'keep');
  const fresh = runNsis(installer, ['/S', `/D=${target}`]);
  assert.equal(fresh.status, 0, String(fresh.error || fresh.stderr));
  for (const args of [[], ['/UPDATE'], []]) {
    const stale = join(target, 'nodejs/node_modules/npm/node_modules/minipass-flush/node_modules/minipass/index.js');
    put(stale, 'module.exports = class Minipass {};');
    const result = runNsis(installer, ['/S', ...args, `/D=${target}`]);
    assert.equal(result.status, 0, String(result.error || result.stderr));
    assert.equal(existsSync(stale), false);
    const modules = join(target, 'nodejs/node_modules/npm/node_modules');
    assert.equal(probe(modules).status, 0);
    assert.equal(probe(modules, 'minipass-pipeline').status, 0);
    assert.equal(readFileSync(unrelated, 'utf8'), 'keep');
  }
  put(join(target, 'nodejs/obsolete-dependency/index.js'), 'obsolete');
  const result = runNsis(join(target, 'uninstall.exe'), ['/S', `_?=${target}`]);
  assert.equal(result.status, 0, String(result.error || result.stderr));
  assert.equal(existsSync(join(target, 'nodejs')), false);
  assert.equal(readFileSync(unrelated, 'utf8'), 'keep');
});

test('Windows NSIS refuses to copy resources when the old runtime cannot be removed', { skip: process.platform !== 'win32' || !hasCompiler }, t => {
  const { root, installer } = compileFixture(t);
  const target = join(root, 'blocked');
  // A file in place of the directory exercises RMDir's native error branch
  // without locks, credentials, or processes belonging to a real installation.
  put(join(target, 'nodejs'), 'cannot remove as a directory');
  const result = runNsis(installer, ['/S', `/D=${target}`]);
  assert.equal(result.status, 2);
  assert.equal(existsSync(join(target, 'installed.marker')), false);
  assert.equal(readFileSync(join(target, 'nodejs'), 'utf8'), 'cannot remove as a directory');
});
