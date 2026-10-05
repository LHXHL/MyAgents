#!/usr/bin/env node

import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const PACKAGE = '@anthropic-ai/claude-agent-sdk';
const PLATFORMS = [
  'darwin-arm64', 'darwin-x64',
  'linux-arm64', 'linux-arm64-musl', 'linux-x64', 'linux-x64-musl',
  'win32-arm64', 'win32-x64',
];

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

export function verifyClaudeSdkWrapper(root) {
  const project = resolve(root);
  const manifest = readJson(join(project, 'package.json'));
  const lock = readJson(join(project, 'package-lock.json'));
  const expected = manifest.dependencies?.[PACKAGE];
  if (!expected || lock.packages?.[`node_modules/${PACKAGE}`]?.version !== expected) {
    throw new Error('Claude Agent SDK wrapper version differs between package.json and package-lock.json');
  }
  for (const platform of PLATFORMS) {
    const native = `${PACKAGE}-${platform}`;
    if (manifest.optionalDependencies?.[native] !== expected ||
        lock.packages?.[`node_modules/${native}`]?.version !== expected) {
      throw new Error(`${native} does not match the pinned Claude Agent SDK ${expected}`);
    }
  }
  const installed = readJson(join(project, 'node_modules', PACKAGE, 'package.json'));
  if (installed.name !== PACKAGE || installed.version !== expected) {
    throw new Error(`Installed Claude Agent SDK wrapper is not ${expected}; run npm install in this checkout`);
  }
  console.log(`Claude Agent SDK wrapper ${expected} matches the project lock`);
  return expected;
}

if (process.argv[1] && resolve(process.argv[1]) === import.meta.filename) {
  try {
    verifyClaudeSdkWrapper(resolve(import.meta.dirname, '..'));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
