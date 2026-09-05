import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';

import { build } from 'esbuild';

const execFileAsync = promisify(execFile);
const repoRoot = resolve(import.meta.dirname, '..');

test('built CLI keeps general surfaces and #523/#524 on exact routes', async () => {
  const scratch = await mkdtemp(join(tmpdir(), 'myagents-cli-contract-'));
  const outfile = join(scratch, 'myagents.cjs');
  const attachment = join(scratch, 'evidence.txt');
  const requests = [];
  const scopedServers = [];
  const server = createServer((request, response) => {
    const chunks = [];
    request.on('data', chunk => chunks.push(chunk));
    request.on('end', () => {
      requests.push({
        url: request.url,
        body: JSON.parse(Buffer.concat(chunks).toString('utf8')),
      });
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ success: true, data: {} }));
    });
  });

  try {
    await build({
      absWorkingDir: repoRoot,
      entryPoints: ['src/cli/myagents.ts'],
      outfile,
      bundle: true,
      platform: 'node',
      target: 'node22',
      format: 'cjs',
      define: { __MYAGENTS_VERSION__: JSON.stringify('0.4.7-test') },
    });
    await writeFile(attachment, 'evidence', 'utf8');
    await new Promise((resolveListen, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolveListen);
    });
    const address = server.address();
    assert.ok(address && typeof address === 'object');

    const cases = [
      {
        args: ['space', 'issue', 'list'],
        path: '/api/admin/space/issue-list',
        overrideInheritedPort: true,
      },
      { args: ['space', 'goal', 'list'], path: '/api/admin/space/goal-list' },
      { args: ['space', 'assignee', 'list'], path: '/api/admin/space/assignee-list' },
      { args: ['space', 'whoami'], path: '/api/admin/space/whoami' },
      {
        args: ['space', 'issue', 'claim', 'iss_523', '--deliveryId', 'delivery_1'],
        path: '/api/admin/space/issue-claim',
        body: { issueId: 'iss_523', deliveryId: 'delivery_1' },
      },
      {
        args: ['space', 'issue', 'attachment', 'add', 'iss_523', '--file', attachment],
        path: '/api/admin/space/attachment-add',
        body: { issueId: 'iss_523', filePaths: [attachment] },
      },
      {
        args: ['space', 'issue', 'complete', 'iss_523'],
        path: '/api/admin/space/issue-complete',
        body: { issueId: 'iss_523' },
      },
    ];

    for (const contract of cases) {
      const before = requests.length;
      await execFileAsync(process.execPath, [
        outfile,
        ...contract.args,
        '--space',
        'official',
        '--workspacePath',
        scratch,
        '--json',
        ...(contract.overrideInheritedPort ? ['--port', String(address.port)] : []),
      ], {
        cwd: repoRoot,
        env: {
          ...process.env,
          VITEST: '',
          MYAGENTS_SESSION_ID: undefined,
          MYAGENTS_PORT: contract.overrideInheritedPort ? '1' : String(address.port),
        },
      });
      assert.equal(requests.length, before + 1);
      const observed = requests.at(-1);
      assert.equal(observed.url, contract.path);
      assert.equal(observed.body.spaceSlug, 'official');
      if (contract.body) {
        for (const [key, value] of Object.entries(contract.body)) {
          assert.deepEqual(observed.body[key], value);
        }
      }
      assert.doesNotMatch(observed.url, /^\/api\/admin\/space\/(issue|goal|assignee|attachment)$/);
    }

    const beforeHelp = requests.length;
    const help = await execFileAsync(process.execPath, [outfile, '--help'], {
      cwd: repoRoot,
      env: { ...process.env, VITEST: '', MYAGENTS_PORT: '', MYAGENTS_SESSION_ID: undefined },
    });
    assert.match(help.stdout, /Usage: myagents/);
    assert.equal(requests.length, beforeHelp, 'top-level help must remain local');

    for (const contract of [
      { args: ['version'], path: '/api/admin/version' },
      { args: ['--version'], path: '/api/admin/version' },
      { args: ['status'], path: '/api/admin/status' },
      { args: ['mcp', 'list'], path: '/api/admin/mcp/list' },
      { args: ['task', 'list'], path: '/api/admin/task/list' },
      { args: ['goal', 'list'], path: '/api/admin/goal/get' },
      { args: ['space', 'list'], path: '/api/admin/space/list' },
    ]) {
      const before = requests.length;
      await execFileAsync(process.execPath, [outfile, ...contract.args, '--json'], {
        cwd: repoRoot,
        env: { ...process.env, VITEST: '', MYAGENTS_PORT: String(address.port), MYAGENTS_SESSION_ID: undefined },
      });
      assert.equal(requests.length, before + 1);
      assert.equal(requests.at(-1).url, contract.path);
    }

    const scopedRequests = [];
    for (const sessionId of ['product-session-a', 'product-session-b']) {
      const scopedServer = createServer((request, response) => {
        request.resume();
        scopedRequests.push({ sessionId, path: request.url, header: request.headers['x-myagents-session-id'] });
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ success: true, data: { sessionId } }));
      });
      scopedServers.push(scopedServer);
      await new Promise((resolveListen, reject) => {
        scopedServer.once('error', reject);
        scopedServer.listen(0, '127.0.0.1', resolveListen);
      });
      const scopedAddress = scopedServer.address();
      assert.ok(scopedAddress && typeof scopedAddress === 'object');
      for (const args of [['agent', 'current'], ['task', 'list'], ['goal', 'list']]) {
        const output = await execFileAsync(process.execPath, [outfile, ...args, '--json'], {
          cwd: scratch,
          env: { ...process.env, VITEST: '', MYAGENTS_PORT: String(scopedAddress.port), MYAGENTS_SESSION_ID: sessionId },
        });
        assert.match(output.stdout, new RegExp(sessionId));
        assert.equal(scopedRequests.at(-1).header, sessionId);
        assert.equal(scopedRequests.at(-1).sessionId, sessionId);
      }
    }
    const beforeInvalid = requests.length + scopedRequests.length;
    for (const [port, sessionId, code] of [
      ['', 'product-session-a', 'CLI_SESSION_ROUTE_REQUIRED'],
      ['not-a-port', 'product-session-a', 'CLI_SESSION_ROUTE_REQUIRED'],
      [String(address.port), '', 'CLI_SESSION_SCOPE_INVALID'],
      [String(address.port), 'invalid/session', 'CLI_SESSION_SCOPE_INVALID'],
    ]) {
      await assert.rejects(execFileAsync(process.execPath, [outfile, 'agent', 'current', '--json'], {
        cwd: scratch,
        env: { ...process.env, VITEST: '', MYAGENTS_PORT: port, MYAGENTS_SESSION_ID: sessionId },
      }), error => {
        assert.equal(error.code, 3);
        assert.equal(JSON.parse(error.stdout).code, code);
        return true;
      });
    }
    assert.equal(requests.length + scopedRequests.length, beforeInvalid, 'invalid Session routes must fail before HTTP');
  } finally {
    await Promise.all(scopedServers.map(server => new Promise(resolveClose => server.close(resolveClose))));
    await new Promise(resolveClose => server.close(resolveClose));
    await rm(scratch, { recursive: true, force: true });
  }
});
