import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

const root = resolve(import.meta.dirname, '..');
const cases = JSON.parse(readFileSync(join(root, 'src/shared/__fixtures__/memory-rule-discovery.json'), 'utf8'));
const scripts = {
  gardener: join(root, 'bundled-skills/myagents-memory-gardener/scripts/memory_lint.py'),
  molt: join(root, 'bundled-skills/myagents-memory-molt/scripts/prepare_molt.py'),
};
function workspace(t) {
  const repo = mkdtempSync(join(tmpdir(), 'memory-architecture-'));
  t.after(() => rmSync(repo, { recursive: true, force: true }));
  mkdirSync(join(repo, '.claude/rules'), { recursive: true });
  return repo;
}
function run(kind, repo, ...args) {
  const result = spawnSync(process.platform === 'win32' ? 'python' : 'python3',
    ['-B', scripts[kind], '--repo', repo, ...args], { encoding: 'utf8', cwd: repo });
  assert.equal(result.status, 0, result.error?.message || result.stderr);
  return result.stdout;
}
function rule(repo, name, content = '- Existing principle\n') {
  writeFileSync(join(repo, '.claude/rules', name), content);
}
function progress(repo) {
  const folder = join(repo, 'memory/molts');
  return readFileSync(join(folder, readdirSync(folder).find(name => name.endsWith('.progress.md'))), 'utf8');
}
for (const { name, matches } of cases) {
  test(`Rust and both maintenance scripts recognize the same memory filename: ${name}`, t => {
    const repo = workspace(t);
    rule(repo, name, '- unique belief\n');
    const report = JSON.parse(run('gardener', repo, '--json'));
    assert.equal(report.some(item => item.check === 'budget' && item.message.includes(name)), matches);
    assert.ok(!report.some(item => item.check === 'substrate' && item.level !== 'INFO'));
    run('molt', repo, '--init-progress');
    assert.equal(progress(repo).includes(`${name}: unique belief`), matches);
    assert.deepEqual(readdirSync(join(repo, '.claude/rules')), [name]);
  });
}
test('custom and multiple memory files are all audited without synthesizing optional layers', t => {
  const repo = workspace(t);
  rule(repo, '06-MEMORY.md', '- first principle\n');
  rule(repo, 'other-MeMoRy.MD', '- second principle; memory/topics/missing.md\n' + 'x'.repeat(52 * 1024));
  rule(repo, 'custom-rules.md');
  const report = JSON.parse(run('gardener', repo, '--json'));
  assert.ok(report.some(item => item.check === 'pointer' && item.level === 'RED'));
  assert.ok(report.some(item => item.check === 'budget' && item.level === 'RED' && item.message.includes('other-MeMoRy.MD')));
  const preparation = run('molt', repo);
  for (const name of ['06-MEMORY.md', 'other-MeMoRy.MD', 'custom-rules.md']) assert.ok(preparation.includes(name));
  assert.ok(!preparation.includes('MISSING'));
  run('molt', repo, '--init-progress');
  assert.ok(progress(repo).includes('first principle'));
  assert.ok(progress(repo).includes('second principle'));
  assert.equal(readdirSync(join(repo, '.claude/rules')).length, 3);
});
test('empty or absent rule directory does not demand a default file set', t => {
  const repo = workspace(t);
  for (const remove of [false, true]) {
    if (remove) rmSync(join(repo, '.claude'), { recursive: true });
    const report = JSON.parse(run('gardener', repo, '--json'));
    assert.ok(!report.some(item => item.check === 'substrate' && item.level !== 'INFO'));
    assert.ok(!run('molt', repo).includes('MISSING'));
  }
});
test('nested files, directories and symlinks do not masquerade as direct rules', { skip: process.platform === 'win32' }, t => {
  const repo = workspace(t);
  const rules = join(repo, '.claude/rules');
  mkdirSync(join(rules, 'nested-memory.md'));
  writeFileSync(join(rules, 'nested-memory.md/MEMORY.md'), '- nested\n');
  writeFileSync(join(repo, 'external.md'), '- linked\n');
  symlinkSync(join(repo, 'external.md'), join(rules, 'link-memory.md'));
  const report = JSON.parse(run('gardener', repo, '--json'));
  assert.ok(!report.some(item => item.check === 'budget'));
  run('molt', repo, '--init-progress');
  assert.ok(!progress(repo).includes(': linked'));
  assert.ok(!progress(repo).includes(': nested'));
});
