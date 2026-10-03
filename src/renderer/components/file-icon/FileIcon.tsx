import { memo } from "react";

import { FILE_ICON_GLYPHS, type FileIconGlyph } from "./fileIconGlyphs";
import {
  resolveFileIconDescriptor,
  type FileIconResolveInput,
} from "./fileIconRegistry";

export const FILE_ICON_SIZES = {
  inline: "1.2em",
  dense: 16,
  regular: 20,
  display: 24,
} as const;

export type FileIconSize = keyof typeof FILE_ICON_SIZES;

export interface FileIconProps extends FileIconResolveInput {
  size?: FileIconSize;
  className?: string;
  /** Leave unset when a visible filename already labels the icon. */
  label?: string;
}

// Shared with AppIcons: 20-unit drawing grid shown through a 16.5-unit crop.
const VIEW_BOX = "1.75 1.75 16.5 16.5";
const STROKE = 1.35;
const GLYPH_SCALE = 1.85;
const GLYPH_TRANSFORM = `translate(10 10) scale(${GLYPH_SCALE}) translate(-10 -12.5)`;
const GLYPH_STROKE = STROKE / GLYPH_SCALE;
const FOLDER =
  "M2.75 6.25a2.5 2.5 0 0 1 2.5-2.5h2.6l1.9 2h5a2.5 2.5 0 0 1 2.5 2.5v5.5a2.5 2.5 0 0 1-2.5 2.5h-9.5a2.5 2.5 0 0 1-2.5-2.5z";
const FOLDER_OPEN_BACK =
  "M2.75 14V6.25a2.5 2.5 0 0 1 2.5-2.5h2.6l1.9 2h5a2.5 2.5 0 0 1 2.5 2.5v.25";
const FOLDER_OPEN_FRONT =
  "M2.75 14l1.8-4.55a2 2 0 0 1 1.85-1.25h10.1a1 1 0 0 1 .95 1.35l-1.55 4.45a2.5 2.5 0 0 1-2.35 1.75h-8.3a2.5 2.5 0 0 1-2.5-1.75z";

function GlyphBody({ icon }: { icon: FileIconGlyph }) {
  if (icon.shape === "folder") {
    return <path d={FOLDER} fill="currentColor" fillOpacity={0.16} />;
  }
  if (icon.shape === "folder-open") {
    return (
      <>
        <path d={FOLDER_OPEN_BACK} />
        <path d={FOLDER_OPEN_FRONT} fill="currentColor" fillOpacity={0.16} />
      </>
    );
  }
  return (
    <g transform={GLYPH_TRANSFORM} strokeWidth={GLYPH_STROKE}>
      {icon.glyph}
    </g>
  );
}

/**
 * The sole renderer for concrete file/folder identity. Classification is pure
 * and synchronous; glyphs are inline SVG coloured by `--file-icon-<tone>`
 * tokens so every Theme and color scheme follows without separate assets.
 */
export const FileIcon = memo(function FileIcon({
  name,
  nodeKind = "file",
  expanded = false,
  size = "dense",
  className,
  label,
}: FileIconProps) {
  const descriptor = resolveFileIconDescriptor({ name, nodeKind, expanded });
  const icon: FileIconGlyph = FILE_ICON_GLYPHS[descriptor.iconId];
  const dimension = FILE_ICON_SIZES[size];
  const pixels = typeof dimension === "number" ? dimension : undefined;
  const inline = size === "inline";

  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox={VIEW_BOX}
      width={pixels}
      height={pixels}
      fill="none"
      stroke="currentColor"
      strokeWidth={STROKE}
      strokeLinecap="round"
      strokeLinejoin="round"
      role={label ? "img" : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      focusable="false"
      className={`inline-block shrink-0 select-none${className ? ` ${className}` : ""}`}
      style={{
        width: dimension,
        height: dimension,
        color: `var(--file-icon-${icon.tone})`,
        // Keep the visual center at 0.375em above the text baseline.
        ...(inline ? { verticalAlign: "-0.225em" } : {}),
      }}
      data-file-icon-id={descriptor.iconId}
      data-file-icon-category={descriptor.category}
      data-file-icon-matched-by={descriptor.matchedBy}
    >
      <GlyphBody icon={icon} />
    </svg>
  );
});
