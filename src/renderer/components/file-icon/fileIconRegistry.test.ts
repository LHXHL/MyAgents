import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { FILE_ICON_GLYPHS, FILE_ICON_TONES } from "./fileIconGlyphs";
import {
  CATEGORY_EXTENSION_RULES,
  COMPOUND_EXTENSION_RULES,
  DEDICATED_EXTENSION_RULES,
  FILENAME_RULES,
  resolveFileIconDescriptor,
  type ExtensionRule,
} from "./fileIconRegistry";

describe("resolveFileIconDescriptor", () => {
  it.each([
    [{ name: "src", nodeKind: "directory" as const }, "folder", "node-kind"],
    [
      { name: "src", nodeKind: "directory" as const, expanded: true },
      "folder-open",
      "node-kind",
    ],
    [{ name: "README.md" }, "markdown", "filename"],
    [{ name: "/repo/ReadMe.MD" }, "markdown", "filename"],
    [{ name: "LICENSE.txt" }, "license", "filename"],
    [{ name: ".env.local" }, "config", "filename"],
    [{ name: "types.d.ts" }, "declaration", "compound-extension"],
    [{ name: "backup.tar.gz" }, "archive", "compound-extension"],
    [{ name: "REPORT.PDF" }, "pdf", "extension"],
    [{ name: "notes.docx" }, "word", "extension"],
    [{ name: "notes.wps" }, "word", "extension"],
    [{ name: "ledger.xlsx" }, "spreadsheet", "extension"],
    [{ name: "ledger.et" }, "spreadsheet", "extension"],
    [{ name: "pitch.pptx" }, "presentation", "extension"],
    [{ name: "pitch.dps" }, "presentation", "extension"],
    [{ name: "component.tsx" }, "react", "extension"],
    [{ name: "photo.avif" }, "image", "category"],
    [{ name: "archive.unknown" }, "file-generic", "fallback"],
    [{ name: ".unknown" }, "file-generic", "fallback"],
    [{ name: "Makefile" }, "config", "filename"],
    [{ name: "C:\\repo\\src\\main.rs" }, "rust", "extension"],
  ])("resolves %o to %s through %s", (input, iconId, matchedBy) => {
    expect(resolveFileIconDescriptor(input)).toMatchObject({
      iconId,
      matchedBy,
    });
  });

  it("always returns a concrete asset", () => {
    const inputs = [
      "",
      "file",
      ".gitignore",
      "notes.wps",
      "table.et",
      "deck.dps",
      "model.glb",
    ];

    for (const name of inputs) {
      const descriptor = resolveFileIconDescriptor({ name });
      expect(FILE_ICON_GLYPHS[descriptor.iconId].tone).toBeTruthy();
    }
  });
});

function flattenExtensions(rules: readonly ExtensionRule[]): string[] {
  return rules.flatMap((rule) => [...rule.extensions]);
}

describe("file icon registry contract", () => {
  it.each([
    ["compound", COMPOUND_EXTENSION_RULES],
    ["dedicated", DEDICATED_EXTENSION_RULES],
    ["category", CATEGORY_EXTENSION_RULES],
  ] as const)("has no duplicate %s extensions", (_label, rules) => {
    const values = flattenExtensions(rules).map((value) => value.toLowerCase());
    expect(new Set(values).size).toBe(values.length);
  });

  it("has no duplicate normalized exact filenames", () => {
    const names = FILENAME_RULES.flatMap((rule) =>
      rule.kind === "exact" ? rule.names.map((name) => name.toLowerCase()) : [],
    );

    expect(new Set(names).size).toBe(names.length);
  });

  it("does not shadow category extensions with dedicated rules", () => {
    const dedicated = new Set(flattenExtensions(DEDICATED_EXTENSION_RULES));
    expect(
      flattenExtensions(CATEGORY_EXTENSION_RULES).filter((value) =>
        dedicated.has(value),
      ),
    ).toEqual([]);
  });

  it("orders compound extension groups by longest suffix first", () => {
    const minimumLengths = COMPOUND_EXTENSION_RULES.map((rule) =>
      Math.min(...rule.extensions.map((extension) => extension.length)),
    );
    expect(minimumLengths).toEqual([...minimumLengths].sort((a, b) => b - a));
  });

  it("keeps every rule asset valid", () => {
    const iconIds = [
      ...FILENAME_RULES.map((rule) => rule.iconId),
      ...COMPOUND_EXTENSION_RULES.map((rule) => rule.iconId),
      ...DEDICATED_EXTENSION_RULES.map((rule) => rule.iconId),
      ...CATEGORY_EXTENSION_RULES.map((rule) => rule.iconId),
    ];

    for (const iconId of iconIds) {
      expect(FILE_ICON_GLYPHS).toHaveProperty(iconId);
    }
  });

  it("does not expose product assets without a registry consumer", () => {
    const referenced = new Set([
      "folder",
      "folder-open",
      "file-generic",
      ...FILENAME_RULES.map((rule) => rule.iconId),
      ...COMPOUND_EXTENSION_RULES.map((rule) => rule.iconId),
      ...DEDICATED_EXTENSION_RULES.map((rule) => rule.iconId),
      ...CATEGORY_EXTENSION_RULES.map((rule) => rule.iconId),
    ]);

    expect(
      Object.keys(FILE_ICON_GLYPHS).filter((id) => !referenced.has(id)),
    ).toEqual([]);
  });

  it("defines every glyph tone for both color schemes", () => {
    // Glyphs are inline SVG coloured by CSS tokens; a missing token renders the
    // icon in the inherited text colour and silently drops the type signal.
    const css = readFileSync(resolve(import.meta.dirname, "../../index.css"), "utf8");
    const block = (selector: string) => {
      const start = css.indexOf(`${selector} {\n  /* file-icon tones */`);
      expect(start, selector).toBeGreaterThanOrEqual(0);
      return css.slice(start, css.indexOf("}", start));
    };
    for (const scheme of [":root", "html[data-color-scheme='dark']"]) {
      const tokens = block(scheme);
      for (const tone of FILE_ICON_TONES) {
        expect(tokens, `${scheme} --file-icon-${tone}`).toContain(`--file-icon-${tone}:`);
      }
    }
    for (const glyph of Object.values(FILE_ICON_GLYPHS)) {
      expect(FILE_ICON_TONES).toContain(glyph.tone);
    }
  });
});
