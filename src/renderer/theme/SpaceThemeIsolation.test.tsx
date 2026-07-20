import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { themeRegistry } from './registry';

const STYLE_ID = 'space-theme-isolation-test-styles';
const rendererStylesheetText = readFileSync(resolve(import.meta.dirname, '../index.css'), 'utf8');
function ruleText(selector: string): string {
  const start = rendererStylesheetText.indexOf(`${selector} {`);
  const end = rendererStylesheetText.indexOf('}', start);
  if (start < 0 || end < 0) throw new Error(`Missing Space scope: ${selector}`);
  return rendererStylesheetText.slice(start, end + 1);
}

const spaceRules = [
  ruleText('[data-ui-theme="space-mono"]'),
  ruleText('.dark [data-ui-theme="space-mono"]'),
].join('\n');
const scopedTokens = [...new Set(
  [...spaceRules.matchAll(/(--[a-z0-9-]+)\s*:/gi)].map(match => match[1]),
)];

const representativeVisualTokens = [
  '--font-body',
  '--font-code',
  '--paper',
  '--paper-elevated',
  '--paper-inset',
  '--ink',
  '--ink-muted',
  '--line',
  '--line-strong',
  '--accent',
  '--button-primary-bg',
  '--button-secondary-bg',
  '--success',
  '--error',
  '--warning',
  '--info',
  '--theme-radius-xl',
  '--theme-shadow-sm',
  '--theme-shadow-md',
  '--theme-shadow-xl',
  '--code-bg',
] as const;

afterEach(() => {
  document.getElementById(STYLE_ID)?.remove();
  document.body.replaceChildren();
  document.documentElement.className = '';
  delete document.documentElement.dataset.themeId;
  delete document.documentElement.dataset.colorScheme;
});

describe('Space Theme isolation', () => {
  it('owns the foundations used by real Space surfaces, not only action colors', () => {
    expect(scopedTokens).toEqual(expect.arrayContaining([...representativeVisualTokens]));
  });

  it.each(['light', 'dark'] as const)(
    'keeps scoped %s visual computed styles identical across all production Theme IDs',
    (scheme) => {
      const style = document.createElement('style');
      style.id = STYLE_ID;
      document.head.appendChild(style);
      const surface = document.createElement('section');
      surface.dataset.uiTheme = 'space-mono';
      document.body.appendChild(surface);

      let baseline: string[] | null = null;
      for (const definition of themeRegistry.getAcceptedDefinitions()) {
        style.textContent = `${definition.stylesheetText}\n${spaceRules}`;
        document.documentElement.dataset.themeId = definition.id;
        document.documentElement.dataset.colorScheme = scheme;
        document.documentElement.classList.toggle('dark', scheme === 'dark');

        const computed = getComputedStyle(surface);
        const values = [
          ...scopedTokens.map(token => computed.getPropertyValue(token).trim()),
          computed.fontFamily,
          computed.color,
        ];
        expect(values.every(Boolean), `${definition.id}.${scheme} scoped tokens`).toBe(true);
        if (baseline === null) baseline = values;
        else expect(values, `${definition.id}.${scheme} Space scope`).toEqual(baseline);
      }
    },
  );
});
