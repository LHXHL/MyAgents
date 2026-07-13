import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { OverflowNameTooltip } from "./OverflowNameTooltip";

function setMeasuredWidth(
  element: HTMLElement,
  widths: { clientWidth: number; scrollWidth: number },
) {
  Object.defineProperty(element, "clientWidth", {
    configurable: true,
    value: widths.clientWidth,
  });
  Object.defineProperty(element, "scrollWidth", {
    configurable: true,
    value: widths.scrollWidth,
  });
}

describe("OverflowNameTooltip", () => {
  it("shows the full name immediately when the visible text is truncated", async () => {
    const label = "2026.7.7-super-long-research-document-version-final.md";
    render(<OverflowNameTooltip label={label} className="block truncate" />);

    const trigger = screen.getByText(label);
    setMeasuredWidth(trigger, { clientWidth: 80, scrollWidth: 360 });
    fireEvent.pointerEnter(trigger);

    expect(await screen.findByRole("tooltip")).toHaveTextContent(label);
  });

  it("does not show a tooltip for names that already fit", () => {
    const label = "README.md";
    render(<OverflowNameTooltip label={label} className="block truncate" />);

    const trigger = screen.getByText(label);
    setMeasuredWidth(trigger, { clientWidth: 160, scrollWidth: 80 });
    fireEvent.pointerEnter(trigger);

    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
  });
});
