#!/usr/bin/env node

import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, closeSync, copyFileSync, existsSync, mkdirSync, openSync, readFileSync, readSync, renameSync, rmSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const PACKAGE = '@anthropic-ai/claude-agent-sdk';
const NATIVE = `${PACKAGE}-linux-x64`;

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function sha256(path) {
  const hash = createHash('sha256');
  const fd = openSync(path, 'r');
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    for (let size = readSync(fd, buffer, 0, buffer.length, null); size > 0;
      size = readSync(fd, buffer, 0, buffer.length, null)) {
      hash.update(buffer.subarray(0, size));
    }
  } finally {
    closeSync(fd);
  }
  return hash.digest('hex');
}

export function stageClaudeSdkLinux(root) {
  const project = resolve(root);
  const manifest = readJson(join(project, 'package.json'));
  const lock = readJson(join(project, 'package-lock.json'));
  const expected = manifest.dependencies?.[PACKAGE];
  if (!expected || manifest.optionalDependencies?.[NATIVE] !== expected ||
      lock.packages?.[`node_modules/${PACKAGE}`]?.version !== expected ||
      lock.packages?.[`node_modules/${NATIVE}`]?.version !== expected) {
    throw new Error('Claude SDK wrapper/native versions disagree in package.json or package-lock.json');
  }
  for (const name of [PACKAGE, NATIVE]) {
    const installed = readJson(join(project, 'node_modules', name, 'package.json'));
    if (installed.name !== name || installed.version !== expected) {
      throw new Error(`${name} is not installed at ${expected}; run npm ci on the Linux host`);
    }
  }

  const source = join(project, 'node_modules', NATIVE, 'claude');
  const sourceInfo = statSync(source);
  if (!sourceInfo.isFile() || sourceInfo.size < 1024 * 1024 ||
      (process.platform === 'linux' && !(sourceInfo.mode & 0o111))) {
    throw new Error(`Claude SDK native executable is missing or not executable: ${source}`);
  }
  const fd = openSync(source, 'r');
  const header = Buffer.alloc(20);
  try {
    if (readSync(fd, header, 0, header.length, 0) !== header.length ||
        header.subarray(0, 4).toString('hex') !== '7f454c46' ||
        header[4] !== 2 || header[5] !== 1 || header.readUInt16LE(18) !== 62) {
      throw new Error(`Claude SDK native executable is not Linux x64 ELF: ${source}`);
    }
  } finally {
    closeSync(fd);
  }

  const destination = join(project, 'src-tauri', 'resources', 'claude-agent-sdk', 'claude');
  mkdirSync(dirname(destination), { recursive: true });
  const temporary = `${destination}.staging-${randomUUID()}`;
  try {
    copyFileSync(source, temporary);
    chmodSync(temporary, sourceInfo.mode & 0o777);
    if (sha256(source) !== sha256(temporary)) {
      throw new Error('Claude SDK staging copy differs from validated npm package');
    }
    renameSync(temporary, destination);
  } finally {
    if (existsSync(temporary)) rmSync(temporary);
  }
  console.log(`Claude SDK linux-x64@${expected} staged from validated npm package`);
}

if (process.argv[1] && resolve(process.argv[1]) === import.meta.filename) {
  try {
    stageClaudeSdkLinux(resolve(import.meta.dirname, '..'));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
