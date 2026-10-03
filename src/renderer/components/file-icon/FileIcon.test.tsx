// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { FileIcon } from "./FileIcon";

describe("FileIcon", () => {
  it("renders a fixed-size decorative inline glyph coloured by its tone token", () => {
    const { container } = render(<FileIcon name="report.pdf" size="regular" />);
    const icon = container.querySelector("svg");

    expect(icon).toHaveAttribute("aria-hidden", "true");
    expect(icon).not.toHaveAttribute("role");
    expect(icon).toHaveAttribute("width", "20");
    expect(icon).toHaveAttribute("height", "20");
    expect(icon).toHaveAttribute("data-file-icon-id", "pdf");
    expect(icon?.style.color).toBe("var(--file-icon-pdf)");
    expect(container.querySelector("img")).toBeNull();
  });

  it("supports an accessible label when the icon stands alone", () => {
    render(<FileIcon name="report.pdf" label="PDF 文件" />);

    expect(screen.getByRole("img", { name: "PDF 文件" })).not.toHaveAttribute(
      "aria-hidden",
    );
  });

  it("uses the expanded folder asset without consumer branching", () => {
    const { container } = render(
      <FileIcon name="docs" nodeKind="directory" expanded />,
    );

    expect(container.querySelector("svg")).toHaveAttribute(
      "data-file-icon-id",
      "folder-open",
    );
  });
});
