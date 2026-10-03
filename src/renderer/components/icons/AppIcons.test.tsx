// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import * as Icons from './AppIcons';
import { CheckIcon, PinIcon, StarIcon, TasksIcon } from './AppIcons';

const iconEntries = Object.entries(Icons).filter(([name]) => name.endsWith('Icon'));

describe('AppIcons', () => {
  it('renders every exported glyph on the shared grid with a stable class', () => {
    expect(iconEntries.length).toBeGreaterThan(140);
    for (const [name, Icon] of iconEntries) {
      const Component = Icon as Icons.AppIconComponent;
      const { container, unmount } = render(<Component />);
      const svg = container.querySelector('svg')!;
      expect(svg, name).toHaveAttribute('viewBox', '1.75 1.75 16.5 16.5');
      expect(svg.getAttribute('class'), name).toMatch(/^app-icon app-icon-[a-z0-9-]+$/);
      expect(svg.children.length, name).toBeGreaterThan(0);
      unmount();
    }
  });

  it('keeps the former lucide prop contract for size, stroke and fill', () => {
    const { container } = render(<StarIcon size={14} strokeWidth={1.5} fill="currentColor" className="h-3 w-3" />);
    const svg = container.querySelector('svg')!;

    expect(svg).toHaveAttribute('width', '14');
    expect(svg).toHaveAttribute('height', '14');
    // strokeWidth is lucide-equivalent: 2 maps to the 1.35-unit product line.
    expect(Number(svg.getAttribute('stroke-width'))).toBeCloseTo(1.5 * (1.35 / 2));
    expect(svg).toHaveAttribute('fill', 'currentColor');
    expect(svg).toHaveClass('app-icon', 'app-icon-star', 'h-3', 'w-3');
  });

  it('is decorative by default and exposed when given an accessible name', () => {
    const { container } = render(<CheckIcon />);
    expect(container.querySelector('svg')).toHaveAttribute('aria-hidden', 'true');

    render(<PinIcon role="img" aria-label="已置顶" />);
    expect(screen.getByRole('img', { name: '已置顶' })).not.toHaveAttribute('aria-hidden');
  });

  it('carries an invisible tint layer that hosts can raise for active states', () => {
    const { container } = render(<TasksIcon />);
    const tint = container.querySelector('.app-icon-tint') as SVGPathElement;

    expect(tint).toHaveAttribute('stroke', 'none');
    expect(tint.style.opacity).toBe('var(--app-icon-tint, 0)');
  });
});
