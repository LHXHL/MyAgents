import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { SpaceAvatar, SpaceIcon } from "./SpaceAvatar";

describe("Space avatar shapes", () => {
  it("distinguishes Space app icons from circular people and Agent avatars", () => {
    render(
      <>
        <SpaceIcon name="Design Space" size={32} />
        <SpaceAvatar name="Ethan" size={32} />
        <SpaceAvatar name="Builder" type="registered_agent" size={32} />
      </>,
    );

    expect(screen.getByText("D").parentElement).toHaveClass("rounded-[22%]");
    expect(screen.getByText("E").parentElement).toHaveClass("rounded-full");
    expect(document.querySelector("svg")?.parentElement).toHaveClass(
      "rounded-full",
    );
  });
});

describe("Space avatar image lifecycle", () => {
  const firstUrl = 'https://avatars.example.test/first.png';
  const nextUrl = 'https://avatars.example.test/next.png';
  const image = (container: HTMLElement) => container.querySelector('img')!;

  it('shows the initial immediately while loading and retains it after failure', () => {
    const { container } = render(<SpaceAvatar name="L Ethan" avatarUrl={firstUrl} />);
    expect(screen.getByText('L')).toBeVisible();
    fireEvent.error(image(container));
    expect(screen.getByText('L')).toBeVisible();
  });

  it('replaces the fallback only after the image loads and restores it on error', () => {
    const { container } = render(<SpaceAvatar name="L Ethan" avatarUrl={firstUrl} />);
    expect(screen.getByText('L')).toBeVisible();
    expect(image(container)).toHaveClass('invisible');
    fireEvent.load(image(container));
    expect(image(container)).not.toHaveClass('invisible');
    expect(screen.queryByText('L')).not.toBeInTheDocument();
    fireEvent.error(image(container));
    expect(screen.getByText('L')).toBeVisible();
  });

  it('isolates replaced URLs from late image events and retries when returning to a failed URL', () => {
    const { container, rerender } = render(<SpaceAvatar name="Alice" avatarUrl={firstUrl} />);
    const oldImage = image(container);
    fireEvent.load(oldImage);
    rerender(<SpaceAvatar name="Bob" avatarUrl={nextUrl} />);
    const nextImage = image(container);
    expect(nextImage).not.toBe(oldImage);
    expect(screen.getByText('B')).toBeVisible();
    fireEvent.load(oldImage);
    fireEvent.error(oldImage);
    expect(screen.getByText('B')).toBeVisible();
    expect(nextImage).toHaveClass('invisible');
    fireEvent.error(nextImage);
    rerender(<SpaceAvatar name="Alice" avatarUrl={firstUrl} />);
    expect(screen.getByText('A')).toBeVisible();
    fireEvent.error(image(container));
    rerender(<SpaceAvatar name="Bob" avatarUrl={nextUrl} />);
    fireEvent.load(image(container));
    rerender(<SpaceAvatar name="Alice" avatarUrl={firstUrl} />);
    expect(image(container)).toHaveAttribute('src', firstUrl);
    expect(screen.getByText('A')).toBeVisible();
    fireEvent.load(image(container));
    expect(screen.queryByText('A')).not.toBeInTheDocument();
  });

  it('has a visible fallback on remount and uses new identity props while pending', () => {
    const first = render(<SpaceAvatar name="L Ethan" avatarUrl={firstUrl} />);
    fireEvent.error(image(first.container));
    first.unmount();
    const { rerender } = render(<SpaceAvatar name="L Ethan" avatarUrl={firstUrl} />);
    expect(screen.getByText('L')).toBeVisible();
    rerender(<SpaceAvatar email="bob@example.test" avatarUrl={firstUrl} />);
    expect(screen.getByText('B')).toBeVisible();
    expect(screen.queryByText('L')).not.toBeInTheDocument();
  });

  it.each(['registered_agent', 'system'] as const)('keeps the %s icon visible during loading and failure', (type) => {
    const { container } = render(<SpaceAvatar type={type} avatarUrl={firstUrl} />);
    expect(container.querySelector('svg')).toBeVisible();
    fireEvent.error(image(container));
    expect(container.querySelector('svg')).toBeVisible();
  });

  it('keeps Space icons stable and removes old image state when the URL is cleared', () => {
    const { container, rerender } = render(<SpaceIcon name="Design" avatarUrl={firstUrl} size={32} />);
    expect(screen.getByText('D')).toBeVisible();
    expect(screen.getByText('D').parentElement).toHaveClass('rounded-[22%]');
    fireEvent.load(image(container));
    rerender(<SpaceIcon name="Design" size={32} />);
    expect(screen.getByText('D')).toBeVisible();
    expect(container.querySelector('img')).not.toBeInTheDocument();
  });
});
