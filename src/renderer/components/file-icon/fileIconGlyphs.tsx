import type { ReactNode } from "react";

/**
 * MyAgents file/folder glyphs. Each glyph is drawn inside a 7×6 box centred at
 * (10, 12.5) on the shared 20-unit icon grid; `FileIcon` scales it to fill the
 * slot and colours it with the `--file-icon-<tone>` token, so light/dark
 * Themes stay legible without per-Theme assets.
 *
 * No third-party brand marks: ecosystems share a glyph (package, lint, config…)
 * or use a short monogram, and colour carries the distinction.
 */
export const FILE_ICON_TONES = [
  "folder",
  "text",
  "markdown",
  "pdf",
  "word",
  "sheet",
  "slides",
  "image",
  "video",
  "audio",
  "config",
  "ts",
  "js",
  "react",
  "html",
  "py",
  "rust",
  "db",
  "shell",
  "json",
  "archive",
  "lock",
  "binary",
  "secure",
  "git",
  "unknown",
] as const;

export type FileIconTone = (typeof FILE_ICON_TONES)[number];

export interface FileIconGlyph {
  tone: FileIconTone;
  shape?: "folder" | "folder-open";
  glyph?: ReactNode;
}

function Monogram({ text, size = 5.6 }: { text: string; size?: number }) {
  return (
    <text
      x="10"
      y="14.55"
      textAnchor="middle"
      fontSize={size}
      fontWeight={640}
      letterSpacing="-0.15"
      fill="currentColor"
      stroke="none"
      style={{ fontFamily: "var(--font-body, system-ui, sans-serif)" }}
    >
      {text}
    </text>
  );
}

const GLYPHS = {
  page: (
    <>
      <path d="M7.5 9.5h3.25l1.75 1.75v3.25a1 1 0 0 1-1 1h-4a1 1 0 0 1-1-1v-4a1 1 0 0 1 1-1z" />
      <path d="M10.75 9.5v1.25a.5.5 0 0 0 .5.5h1.25" />
    </>
  ),
  text: (
    <>
      <path d="M7.25 10h5.5" />
      <path d="M7.25 12.5h5.5" />
      <path d="M7.25 15h3.5" />
    </>
  ),
  // A single "M" mark: the conventional down-arrow reads as a download badge at 16px.
  markdown: <path d="M7.4 14.75V10.5l2.6 2.75 2.6-2.75v4.25" />,
  word: <path d="M6.6 10.25l1.3 4.75 2.1-3.6 2.1 3.6 1.3-4.75" />,
  sheet: (
    <>
      <rect x="6.75" y="9.75" width="6.5" height="5.75" rx="1" />
      <path d="M6.75 12.6h6.5" />
      <path d="M10 9.75v5.75" />
    </>
  ),
  slides: (
    <>
      <rect x="6.5" y="9.75" width="7" height="4.5" rx="1" />
      <path d="M10 14.25v1.5" />
      <path d="M8.5 15.75h3" />
    </>
  ),
  notebook: (
    <>
      <rect x="7" y="9.5" width="6" height="6" rx="1" />
      <path d="M8.75 9.5v6" />
      <path d="M10.4 11.4h1.3M10.4 13.4h1.3" />
    </>
  ),
  image: (
    <>
      <rect x="6.5" y="9.5" width="7" height="6" rx="1.25" />
      <circle cx="8.6" cy="11.4" r="0.75" fill="currentColor" stroke="none" />
      <path d="M6.6 15l2.3-2.3 1.6 1.6 1.1-1.1 1.8 1.8" />
    </>
  ),
  vector: (
    <>
      <path d="M6.75 14.75c1.5-4.5 5-4.5 6.5 0" />
      <rect x="6" y="14" width="1.5" height="1.5" rx="0.3" />
      <rect x="12.5" y="14" width="1.5" height="1.5" rx="0.3" />
      <circle cx="10" cy="10.1" r="0.8" fill="currentColor" stroke="none" />
    </>
  ),
  video: <path d="M8.6 10.1v4.3a.5.5 0 0 0 .75.43l3.4-2.15a.5.5 0 0 0 0-.86l-3.4-2.15a.5.5 0 0 0-.75.43z" />,
  audio: (
    <>
      <path d="M9.1 14.6V10l3.65-.85v4.6" />
      <circle cx="7.95" cy="14.6" r="1.2" fill="currentColor" stroke="none" />
      <circle cx="11.6" cy="13.75" r="1.2" fill="currentColor" stroke="none" />
    </>
  ),
  shell: (
    <>
      <path d="M6.9 10.25l1.9 1.75-1.9 1.75" />
      <path d="M10.4 14.4h2.85" />
    </>
  ),
  tags: (
    <>
      <path d="M8 10.1l-1.9 2.15L8 14.4" />
      <path d="M12 10.1l1.9 2.15L12 14.4" />
      <path d="M10.6 9.6l-1.2 5.3" />
    </>
  ),
  hash: <path d="M9 9.6l-.75 5.8M11.75 9.6L11 15.4M7.25 11.4h5.75M7 13.6h5.75" />,
  code: (
    <>
      <path d="M8 10.1l-1.9 2.15L8 14.4" />
      <path d="M12 10.1l1.9 2.15L12 14.4" />
    </>
  ),
  graph: (
    <>
      <path d="M10 9.5l2.75 1.5v3l-2.75 1.5-2.75-1.5v-3z" />
      <circle cx="10" cy="9.5" r="0.75" fill="currentColor" stroke="none" />
      <circle cx="12.75" cy="14" r="0.75" fill="currentColor" stroke="none" />
      <circle cx="7.25" cy="14" r="0.75" fill="currentColor" stroke="none" />
    </>
  ),
  braces: (
    <>
      <path d="M8.4 9.6c-.9 0-1.2.45-1.2 1.15v.55c0 .5-.25.8-.8.8.55 0 .8.3.8.8v.55c0 .7.3 1.15 1.2 1.15" />
      <path d="M11.6 9.6c.9 0 1.2.45 1.2 1.15v.55c0 .5.25.8.8.8-.55 0-.8.3-.8.8v.55c0 .7-.3 1.15-1.2 1.15" />
    </>
  ),
  config: (
    <>
      <path d="M6.75 10.75h6.5" />
      <path d="M6.75 13.9h6.5" />
      <circle cx="11.25" cy="10.75" r="1.25" fill="currentColor" stroke="none" />
      <circle cx="8.6" cy="13.9" r="1.25" fill="currentColor" stroke="none" />
    </>
  ),
  lint: (
    <>
      <circle cx="10" cy="12.5" r="3" />
      <path d="M8.65 12.6l.95.95 1.8-2.05" />
    </>
  ),
  bolt: <path d="M10.75 9.25L7.9 13h2.35l-.75 2.75 2.85-3.75H10z" />,
  container: (
    <>
      <rect x="6.6" y="12" width="2" height="2" rx="0.4" />
      <rect x="9" y="12" width="2" height="2" rx="0.4" />
      <rect x="11.4" y="12" width="2" height="2" rx="0.4" />
      <rect x="9" y="9.6" width="2" height="2" rx="0.4" />
      <path d="M6.25 14.75c.75 1 2 1.25 3.75 1.25s3.25-.4 4-1.6" />
    </>
  ),
  db: (
    <>
      <ellipse cx="10" cy="10.3" rx="3" ry="1.15"/>
      <path d="M7 10.3v4.2c0 .65 1.35 1.15 3 1.15s3-.5 3-1.15v-4.2" />
      <path d="M7 12.4c0 .65 1.35 1.15 3 1.15s3-.5 3-1.15" />
    </>
  ),
  package: (
    <>
      <path d="M6.6 10.75l3.4-1.6 3.4 1.6v3.6l-3.4 1.6-3.4-1.6z" />
      <path d="M6.6 10.75l3.4 1.6 3.4-1.6" />
      <path d="M10 12.35v3.6" />
    </>
  ),
  hexagon: (
    <>
      <path d="M10 9.25l3 1.65v3.2l-3 1.65-3-1.65v-3.2z" />
      <path d="M10 11.1v2.8" />
    </>
  ),
  lock: (
    <>
      <rect x="7" y="11.6" width="6" height="4" rx="1.1" />
      <path d="M8.35 11.6v-1.1a1.65 1.65 0 0 1 3.3 0v1.1" />
    </>
  ),
  archive: (
    <>
      <rect x="7" y="9.5" width="6" height="6" rx="1.25" />
      <path d="M10 9.5v.75M10 11.25v.75" />
      <rect x="9.1" y="12.6" width="1.8" height="1.65" rx="0.45" />
    </>
  ),
  binary: (
    <>
      <rect x="6.5" y="9.75" width="7" height="5.5" rx="1" />
      <path d="M6.5 11.4h7" />
    </>
  ),
  shield: <path d="M10 9.4l2.9 1v2.05c0 1.7-1.2 2.75-2.9 3.3-1.7-.55-2.9-1.6-2.9-3.3V10.4z" />,
  seal: (
    <>
      <circle cx="10" cy="11.6" r="2.2" />
      <path d="M8.85 13.5l-.6 2.15L10 14.9l1.75.75-.6-2.15" />
    </>
  ),
  branch: (
    <>
      <path d="M7.9 10v5" />
      <path d="M12.1 11.35c0 1.75-1.4 2.4-3.4 2.65" />
      <circle cx="7.9" cy="10" r="1.1" fill="currentColor" stroke="none" />
      <circle cx="7.9" cy="15.1" r="1.1" fill="currentColor" stroke="none" />
      <circle cx="12.1" cy="11.2" r="1.1" fill="currentColor" stroke="none" />
    </>
  ),
  link: (
    <>
      <path d="M9.1 13.4a1.6 1.6 0 0 0 2.25 0l1.15-1.15a1.6 1.6 0 0 0-2.25-2.25l-.45.45" />
      <path d="M10.9 11.6a1.6 1.6 0 0 0-2.25 0L7.5 12.75a1.6 1.6 0 0 0 2.25 2.25l.45-.45" />
    </>
  ),
  question: (
    <>
      <path d="M8.6 11.1a1.45 1.45 0 1 1 2.15 1.25c-.45.25-.75.55-.75 1.05" />
      <circle cx="10" cy="15.1" r="0.8" fill="currentColor" stroke="none" />
    </>
  ),
};

/**
 * Stable product-facing IDs. Consumers never address this map directly;
 * resolver rules choose an ID and FileIcon owns rendering.
 */
export const FILE_ICON_GLYPHS = {
  folder: { tone: 'folder', shape: 'folder' },
  'folder-open': { tone: 'folder', shape: 'folder-open' },
  'file-generic': { tone: 'text', glyph: GLYPHS.page },
  text: { tone: 'text', glyph: GLYPHS.text },
  markdown: { tone: 'markdown', glyph: GLYPHS.markdown },
  pdf: { tone: 'pdf', glyph: <Monogram text="PDF" size={4.6} /> },
  word: { tone: 'word', glyph: GLYPHS.word },
  spreadsheet: { tone: 'sheet', glyph: GLYPHS.sheet },
  presentation: { tone: 'slides', glyph: GLYPHS.slides },
  notebook: { tone: 'slides', glyph: GLYPHS.notebook },
  tex: { tone: 'markdown', glyph: <Monogram text="TeX" size={5} /> },
  image: { tone: 'image', glyph: GLYPHS.image },
  svg: { tone: 'image', glyph: GLYPHS.vector },
  video: { tone: 'video', glyph: GLYPHS.video },
  audio: { tone: 'audio', glyph: GLYPHS.audio },
  font: { tone: 'config', glyph: <Monogram text="Aa" size={5.4} /> },
  typescript: { tone: 'ts', glyph: <Monogram text="TS" /> },
  declaration: { tone: 'ts', glyph: <Monogram text="DTS" size={4.6} /> },
  javascript: { tone: 'js', glyph: <Monogram text="JS" /> },
  react: { tone: 'react', glyph: <Monogram text="TSX" size={4.6} /> },
  vue: { tone: 'sheet', glyph: <Monogram text="VUE" size={4.6} /> },
  svelte: { tone: 'html', glyph: <Monogram text="SV" /> },
  angular: { tone: 'pdf', glyph: <Monogram text="NG" /> },
  astro: { tone: 'image', glyph: <Monogram text="AS" /> },
  python: { tone: 'py', glyph: <Monogram text="PY" /> },
  rust: { tone: 'rust', glyph: <Monogram text="RS" /> },
  go: { tone: 'py', glyph: <Monogram text="GO" /> },
  java: { tone: 'rust', glyph: <Monogram text="JV" /> },
  kotlin: { tone: 'image', glyph: <Monogram text="KT" /> },
  c: { tone: 'db', glyph: <Monogram text="C" size={6.2} /> },
  cpp: { tone: 'ts', glyph: <Monogram text="C++" size={4.8} /> },
  csharp: { tone: 'image', glyph: <Monogram text="C#" size={5.2} /> },
  ruby: { tone: 'pdf', glyph: <Monogram text="RB" /> },
  php: { tone: 'markdown', glyph: <Monogram text="PHP" size={4.6} /> },
  shell: { tone: 'shell', glyph: GLYPHS.shell },
  html: { tone: 'html', glyph: GLYPHS.tags },
  stylesheet: { tone: 'ts', glyph: GLYPHS.hash },
  sass: { tone: 'video', glyph: GLYPHS.hash },
  tailwind: { tone: 'react', glyph: GLYPHS.hash },
  code: { tone: 'ts', glyph: GLYPHS.code },
  graphql: { tone: 'video', glyph: GLYPHS.graph },
  json: { tone: 'json', glyph: GLYPHS.braces },
  yaml: { tone: 'pdf', glyph: GLYPHS.config },
  xml: { tone: 'html', glyph: <Monogram text="XML" size={4.6} /> },
  config: { tone: 'config', glyph: GLYPHS.config },
  editorconfig: { tone: 'config', glyph: GLYPHS.config },
  tsconfig: { tone: 'ts', glyph: GLYPHS.config },
  eslint: { tone: 'image', glyph: GLYPHS.lint },
  prettier: { tone: 'react', glyph: GLYPHS.lint },
  biome: { tone: 'ts', glyph: GLYPHS.lint },
  vite: { tone: 'audio', glyph: GLYPHS.bolt },
  terraform: { tone: 'image', glyph: <Monogram text="TF" /> },
  docker: { tone: 'db', glyph: GLYPHS.container },
  database: { tone: 'db', glyph: GLYPHS.db },
  mongo: { tone: 'sheet', glyph: GLYPHS.db },
  package: { tone: 'pdf', glyph: GLYPHS.package },
  npm: { tone: 'pdf', glyph: GLYPHS.package },
  pnpm: { tone: 'audio', glyph: GLYPHS.package },
  yarn: { tone: 'react', glyph: GLYPHS.package },
  bun: { tone: 'archive', glyph: GLYPHS.package },
  node: { tone: 'sheet', glyph: GLYPHS.hexagon },
  deno: { tone: 'config', glyph: GLYPHS.hexagon },
  next: { tone: 'config', glyph: <Monogram text="N" size={6.4} /> },
  lock: { tone: 'lock', glyph: GLYPHS.lock },
  archive: { tone: 'archive', glyph: GLYPHS.archive },
  binary: { tone: 'binary', glyph: GLYPHS.binary },
  security: { tone: 'secure', glyph: GLYPHS.shield },
  license: { tone: 'secure', glyph: GLYPHS.seal },
  git: { tone: 'git', glyph: GLYPHS.branch },
  github: { tone: 'config', glyph: GLYPHS.branch },
  link: { tone: 'markdown', glyph: GLYPHS.link },
  resource: { tone: 'unknown', glyph: GLYPHS.question },
} as const satisfies Record<string, FileIconGlyph>;

export type FileIconId = keyof typeof FILE_ICON_GLYPHS;
