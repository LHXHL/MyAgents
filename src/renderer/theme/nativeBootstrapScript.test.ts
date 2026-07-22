import { describe, expect, it } from 'vitest';
import scriptTemplate from './native-bootstrap-script.js?raw';

const BOOTSTRAP_KEY = 'myagents:theme-bootstrap';
const APPEARANCE_MARKER = '__MYAGENTS_APPEARANCE_MODE__';
const RUN_ID_MARKER = '__MYAGENTS_BOOTSTRAP_RUN_ID__';

class MemoryStorage implements Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> {
  private readonly values = new Map<string, string>();

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }

  removeItem(key: string): void {
    this.values.delete(key);
  }
}

function executeScript(
  storage: MemoryStorage,
  appearanceMode: 'light' | 'dark' | 'system',
  runId = 'native-run-1',
): void {
  const script = scriptTemplate
    .replace(APPEARANCE_MARKER, JSON.stringify(appearanceMode))
    .replace(RUN_ID_MARKER, JSON.stringify(runId));
  expect(script).not.toContain(APPEARANCE_MARKER);
  expect(script).not.toContain(RUN_ID_MARKER);
  Function('localStorage', script)(storage);
}

function readSnapshot(storage: MemoryStorage): Record<string, unknown> {
  return JSON.parse(storage.getItem(BOOTSTRAP_KEY) ?? 'null') as Record<string, unknown>;
}

describe('native Theme bootstrap script', () => {
  it('uses the current product default and durable appearance when no snapshot exists', () => {
    const storage = new MemoryStorage();

    executeScript(storage, 'dark');

    expect(readSnapshot(storage)).toEqual({
      version: 2,
      themeId: 'default-black',
      appearanceMode: 'dark',
      themeSelectionExplicit: false,
    });
  });

  it('preserves the renderer-resolved Theme ID while aligning appearance', () => {
    const storage = new MemoryStorage();
    storage.setItem(BOOTSTRAP_KEY, JSON.stringify({
      version: 1,
      themeId: 'registered-partner-theme',
      appearanceMode: 'light',
    }));

    executeScript(storage, 'system');

    expect(readSnapshot(storage)).toEqual({
      version: 2,
      themeId: 'registered-partner-theme',
      appearanceMode: 'system',
      themeSelectionExplicit: true,
    });
  });

  it('repairs a corrupt snapshot instead of skipping appearance alignment', () => {
    const storage = new MemoryStorage();
    storage.setItem(BOOTSTRAP_KEY, '{corrupt');
    storage.setItem('theme', 'light');

    executeScript(storage, 'dark');

    expect(readSnapshot(storage)).toEqual({
      version: 2,
      themeId: 'default-black',
      appearanceMode: 'dark',
      themeSelectionExplicit: false,
    });
    expect(storage.getItem('theme')).toBeNull();
  });

  it('does not let an implicit snapshot pin a previous product default', () => {
    const storage = new MemoryStorage();
    storage.setItem(BOOTSTRAP_KEY, JSON.stringify({
      version: 2,
      themeId: 'myagents-default',
      appearanceMode: 'light',
      themeSelectionExplicit: false,
    }));

    executeScript(storage, 'system');

    expect(readSnapshot(storage)).toEqual({
      version: 2,
      themeId: 'default-black',
      appearanceMode: 'system',
      themeSelectionExplicit: false,
    });
  });

  it('does not let a reload restore stale process-start appearance', () => {
    const storage = new MemoryStorage();
    executeScript(storage, 'light', 'native-run-1');

    // ThemeRuntime publishes a newer selection before AppErrorBoundary reloads.
    storage.setItem(BOOTSTRAP_KEY, JSON.stringify({
      version: 2,
      themeId: 'registered-partner-theme',
      appearanceMode: 'dark',
      themeSelectionExplicit: true,
    }));
    executeScript(storage, 'light', 'native-run-1');

    expect(readSnapshot(storage)).toEqual({
      version: 2,
      themeId: 'registered-partner-theme',
      appearanceMode: 'dark',
      themeSelectionExplicit: true,
    });

    // A new native process gets a new run ID and must align from disk again.
    executeScript(storage, 'system', 'native-run-2');
    expect(readSnapshot(storage)).toEqual({
      version: 2,
      themeId: 'registered-partner-theme',
      appearanceMode: 'system',
      themeSelectionExplicit: true,
    });
  });
});
