import { execFile } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { realpath } from 'node:fs/promises';
import { promisify } from 'node:util';
import { applyDshDevelopmentReset, isDshDevelopmentWriterCommand, planDshDevelopmentReset } from '../src/server/integrated-runtimes/dsh/development-reset';

const execute = promisify(execFile);
const args = process.argv.slice(2);
if (args.length !== 0 && (args.length !== 2 || args[0] !== '--apply' || !/^[a-f0-9]{64}$/u.test(args[1]))) {
  throw new Error('Usage: npm run reset:dsh-dev -- [--apply <reviewed-plan-sha256>]');
}
const dataRoot = join(await realpath(homedir()), '.myagents');
// This one-time maintenance command runs only after the app and all Sidecars
// have exited. It never kills an unrelated process or claims the Rust live fence.
async function assertStopped(): Promise<void> {
  const rows: Array<{ pid: number; command: string }> = [];
  if (process.platform === 'win32') {
    const result = await execute('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      'Get-CimInstance Win32_Process | Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress'], { maxBuffer: 8 * 1024 * 1024 });
    const parsed = JSON.parse(result.stdout) as Array<{ ProcessId: number; CommandLine: string | null }>;
    for (const row of parsed) rows.push({ pid: row.ProcessId, command: row.CommandLine ?? '' });
  } else {
    const result = await execute('ps', ['-Ao', 'pid=,args='], { maxBuffer: 8 * 1024 * 1024 });
    for (const line of result.stdout.split('\n')) {
      const match = /^\s*(\d+)\s+(.*)$/u.exec(line);
      if (match) rows.push({ pid: Number(match[1]), command: match[2] });
    }
  }
  if (rows.some(row => row.pid !== process.pid && isDshDevelopmentWriterCommand(row.command))) {
    throw new Error('Development reset requires MyAgents, its Sidecars and DSH Runtime processes to be stopped');
  }
}
const plan = await planDshDevelopmentReset(dataRoot);
if (args.length === 0) {
  process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`);
} else {
  if (args[1] !== plan.sha256) throw new Error('Development reset plan changed; inspect a fresh plan');
  await assertStopped();
  const { resetDshDevelopmentSession } = await import('../src/server/SessionStore');
  const result = await applyDshDevelopmentReset(plan, resetDshDevelopmentSession, assertStopped);
  process.stdout.write(`${JSON.stringify({ ...result, planSha256: plan.sha256, target: plan.target })}\n`);
}
