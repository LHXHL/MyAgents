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

test('built CLI keeps internal surfaces and the public external contract', async () => {
  const scratch = await mkdtemp(join(tmpdir(), 'myagents-cli-contract-'));
  const outfile = join(scratch, 'myagents.cjs');
  const attachment = join(scratch, 'evidence.txt');
  const requests = [];
  const server = createServer((request, response) => {
    const chunks = [];
    request.on('data', chunk => chunks.push(chunk));
    request.on('end', () => {
      requests.push({
        url: request.url,
        body: JSON.parse(Buffer.concat(chunks).toString('utf8')),
        authorization: request.headers.authorization,
      });
      if (request.url === '/api/admin/session/send') {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (body.prompt === 'invalid acknowledgement') {
          response.writeHead(200, { 'content-type': 'application/json' });
          response.end(JSON.stringify({ success: true }));
          return;
        }
        request.socket.destroy();
        return;
      }
      if (request.url === '/api/admin/session/start') {
        setTimeout(() => {
          response.writeHead(200, { 'content-type': 'application/json' });
          response.end(JSON.stringify({
            success: true,
            accepted: true,
            asynchronous: true,
            agentId: 'agent-1',
            sessionId: 'session-delayed',
            messageId: 'message-delayed',
          }));
        }, 10_100);
        return;
      }
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
          MYAGENTS_PORT: contract.overrideInheritedPort ? '1' : String(address.port),
          MYAGENTS_INTERNAL_CLI_TOKEN: 'internal-test-capability',
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
      env: { ...process.env, VITEST: '', MYAGENTS_PORT: '' },
    });
    assert.match(help.stdout, /Usage: myagents/);
    assert.equal(requests.length, beforeHelp, 'top-level help must remain local');

    for (const contract of [
      { args: ['version'], path: '/api/admin/version' },
      { args: ['status'], path: '/api/admin/status' },
      { args: ['mcp', 'list'], path: '/api/admin/mcp/list' },
      { args: ['task', 'list'], path: '/api/admin/task/list' },
      { args: ['goal', 'list'], path: '/api/admin/goal/get' },
      { args: ['space', 'list'], path: '/api/admin/space/list' },
    ]) {
      const before = requests.length;
      await execFileAsync(process.execPath, [outfile, ...contract.args, '--json'], {
        cwd: repoRoot,
        env: {
          ...process.env,
          VITEST: '',
          MYAGENTS_PORT: String(address.port),
          MYAGENTS_INTERNAL_CLI_TOKEN: 'internal-test-capability',
        },
      });
      assert.equal(requests.length, before + 1);
      assert.equal(requests.at(-1).url, contract.path);
    }

    const externalEnv = {
      ...process.env,
      VITEST: '',
      MYAGENTS_PORT: String(address.port),
      MYAGENTS_API_TOKEN: 'external-test-token',
      MYAGENTS_INTERNAL_CLI_TOKEN: '',
    };
    for (const contract of [
      {
        args: ['task', 'list', '--workspacePath', scratch],
        path: '/api/admin/task/list',
        body: { workspacePath: scratch },
      },
      { args: ['task', 'start', 'task-1'], path: '/api/admin/task/start' },
      { args: ['task', 'stop', 'task-1'], path: '/api/admin/task/stop' },
      { args: ['task', 'runs', 'task-1'], path: '/api/admin/task/runs' },
      { args: ['task', 'remove', 'task-1'], path: '/api/admin/task/delete' },
    ]) {
      const before = requests.length;
      await execFileAsync(process.execPath, [outfile, ...contract.args, '--json'], {
        cwd: repoRoot,
        env: externalEnv,
      });
      assert.equal(requests.length, before + 1);
      const observed = requests.at(-1);
      assert.equal(observed.url, contract.path);
      assert.equal(observed.authorization, 'Bearer external-test-token');
      if (contract.body) assert.partialDeepStrictEqual(observed.body, contract.body);
    }

    const beforeOfflineHelp = requests.length;
    const leafHelp = await execFileAsync(process.execPath, [outfile, 'task', 'start', '--help'], {
      cwd: repoRoot,
      env: { ...externalEnv, MYAGENTS_PORT: '' },
    });
    assert.match(leafHelp.stdout, /myagents task start <taskId>/);
    assert.match(leafHelp.stdout, /Effect:/);
    assert.equal(requests.length, beforeOfflineHelp);

    const aliasHelp = await execFileAsync(process.execPath, [outfile, 'task', 'remove', '--help'], {
      cwd: repoRoot,
      env: { ...externalEnv, MYAGENTS_PORT: '' },
    });
    assert.match(aliasHelp.stdout, /myagents task remove <taskId>/);
    assert.doesNotMatch(aliasHelp.stdout, /myagents task delete <taskId>/);

    await assert.rejects(
      execFileAsync(process.execPath, [outfile, 'task', 'start', 'task-1', '--mystery', '--json'], {
        cwd: repoRoot,
        env: externalEnv,
      }),
      error => {
        assert.equal(error.code, 2);
        assert.equal(JSON.parse(error.stdout).code, 'UNKNOWN_FLAG');
        return true;
      },
    );
    assert.equal(requests.length, beforeOfflineHelp);

    const delayedStart = await execFileAsync(process.execPath, [
      outfile,
      'session',
      'start',
      '--agent',
      'agent-1',
      '--prompt',
      'work',
      '--json',
    ], { cwd: repoRoot, env: externalEnv, timeout: 15_000 });
    assert.equal(JSON.parse(delayedStart.stdout).sessionId, 'session-delayed');

    await assert.rejects(
      execFileAsync(process.execPath, [
        outfile,
        'session',
        'send',
        'session-delayed',
        '--prompt',
        'follow up',
        '--json',
      ], { cwd: repoRoot, env: externalEnv }),
      error => {
        assert.equal(error.code, 2);
        const result = JSON.parse(error.stdout);
        assert.equal(result.code, 'admission_unconfirmed');
        assert.equal(result.unconfirmed, true);
        return true;
      },
    );

    await assert.rejects(
      execFileAsync(process.execPath, [
        outfile,
        'session',
        'send',
        'session-delayed',
        '--prompt',
        'invalid acknowledgement',
        '--json',
      ], { cwd: repoRoot, env: externalEnv }),
      error => {
        assert.equal(error.code, 2);
        const result = JSON.parse(error.stdout);
        assert.equal(result.code, 'admission_unconfirmed');
        return true;
      },
    );

    const unavailableServer = createServer();
    await new Promise((resolveListen, reject) => {
      unavailableServer.once('error', reject);
      unavailableServer.listen(0, '127.0.0.1', resolveListen);
    });
    const unavailableAddress = unavailableServer.address();
    assert.ok(unavailableAddress && typeof unavailableAddress === 'object');
    await new Promise(resolveClose => unavailableServer.close(resolveClose));
    const unavailableEnv = {
      ...externalEnv,
      MYAGENTS_PORT: String(unavailableAddress.port),
    };
    for (const extraArgs of [['--json'], []]) {
      await assert.rejects(
        execFileAsync(process.execPath, [
          outfile,
          'session',
          'start',
          '--agent',
          'agent-1',
          '--prompt',
          'work',
          ...extraArgs,
        ], { cwd: repoRoot, env: unavailableEnv }),
        error => {
          assert.equal(error.code, 3);
          if (extraArgs.length > 0) {
            assert.equal(JSON.parse(error.stdout).code, 'MYAGENTS_UNAVAILABLE');
          } else {
            assert.match(error.stderr, /Cannot connect to the MyAgents app/);
          }
          return true;
        },
      );
    }
  } finally {
    await new Promise(resolveClose => server.close(resolveClose));
    await rm(scratch, { recursive: true, force: true });
  }
});
