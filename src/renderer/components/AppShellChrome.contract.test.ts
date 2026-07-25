import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(import.meta.dirname, '../../..');

function source(relativePath: string): string {
  return readFileSync(resolve(root, relativePath), 'utf8');
}

describe('App Shell chrome contract', () => {
  it('keeps Chat navigation tab-owned instead of exposing a back-to-launcher path', () => {
    const chat = source('src/renderer/pages/Chat.tsx');
    const app = source('src/renderer/App.tsx');

    expect(chat).not.toContain('ArrowLeft');
    expect(chat).not.toContain('onBack');
    expect(chat).not.toContain("shell.header.backToProjects");
    expect(app).not.toContain('handleBackToLauncher');
    expect(app).not.toContain('onBack={');
  });

  it('keeps the Chat owner subtree mounted while its existing boot surface covers startup', () => {
    const chat = source('src/renderer/pages/Chat.tsx');
    const app = source('src/renderer/App.tsx');

    expect(app).toContain('<Suspense fallback={<ChatBootOverlay />}>');
    expect(app).not.toContain(') : isLoading ? (\n        <ChatBootOverlay />');
    expect(chat).toContain('<ChatBootOverlay show={showStartupOverlay} />');
  });

  it('uses one simple right-panel glyph and custom tips at the stable far-right slot', () => {
    const chat = source('src/renderer/pages/Chat.tsx');
    const directory = source('src/renderer/components/directory-panel/DirectoryPanel.tsx');
    const rightActions = directory.slice(
      directory.indexOf('{/* Right side buttons */}'),
      directory.indexOf('{/* Collapsible content'),
    );

    expect(chat).toContain('<PanelRight className="h-4 w-4" />');
    expect(chat).not.toContain('PanelRightOpen');
    expect(directory).toContain('<PanelRight className="h-4 w-4" />');
    expect(directory).not.toContain('PanelRightClose');
    expect(rightActions.indexOf('workspaceFiles.directory.agentSettings'))
      .toBeLessThan(rightActions.indexOf('workspaceFiles.directory.collapseWorkspace'));
    expect(rightActions).toContain('className="flex h-7 w-7 items-center justify-center rounded-lg');
    expect(chat).toContain('className="flex h-7 w-7 items-center justify-center rounded-lg');
    expect(rightActions).toContain('aria-label={isCollapsed');
    expect(rightActions).toContain('<Tip');
    expect(rightActions).not.toContain('title=');
  });

  it('wires layout-aware pointer leave handling to the forced-rail workspace flyout', () => {
    const sidebar = source('src/renderer/components/global-sidebar/GlobalSidebar.tsx');

    expect(sidebar).toContain('onPointerLeave={handleFlyoutPointerLeave}');
    expect(sidebar).toContain('isPointerWithinBounds(bounds, event.clientX, event.clientY)');
    expect(sidebar).toContain('previousActiveTabIdRef');
    expect(sidebar).not.toContain('pendingSessionNavigationRef');
  });
});
