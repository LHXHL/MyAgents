/** Presentation-only aliases; Runtime transcripts retain the official DSH name. */
const DSH_TOOL_DISPLAY_NAMES: Readonly<Record<string, string>> = Object.freeze({
  read: 'Read',
  read_image: 'Read',
  write: 'Write',
  edit: 'Edit',
  glob: 'Glob',
  grep: 'Grep',
  web_fetch: 'WebFetch',
  web_search: 'WebSearch',
});

export function dshToolDisplayName(name: string): string {
  return DSH_TOOL_DISPLAY_NAMES[name] ?? name;
}
