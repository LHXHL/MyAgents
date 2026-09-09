import { Facet, RangeSetBuilder, StateEffect, StateField, type EditorState, type Extension, type Text } from '@codemirror/state';
import { Decoration, EditorView, ViewPlugin, WidgetType, type DecorationSet, type ViewUpdate } from '@codemirror/view';
import { syntaxTree } from '@codemirror/language';
import { definitions } from './definitions';

export interface Projection {
  kind: string; from: number; to: number; source: string;
  renderSource?: string;
  /** Immutable CM document identity; a table never copies all its cells to React. */
  tableDocument?: Text;
  containerPrefix?: string;
  definitions?: string;
  footnoteNumbers?: ReadonlyMap<string, number>;
}
export interface ProjectionHost {
  mount(element: HTMLElement, projection: Projection, view: EditorView): void;
  unmount(element: HTMLElement): void;
}
export const projectionHost = Facet.define<ProjectionHost, ProjectionHost>({ combine: values => values[0] });
export const revealBlock = StateEffect.define<{ from: number; to: number } | null>({
  map: (range, changes) => range && ({ from: changes.mapPos(range.from), to: changes.mapPos(range.to, 1) }),
});
const visibleRegion = StateEffect.define<{ from: number; to: number }>();
export const composing = StateEffect.define<boolean>();
export const editorFocused = StateEffect.define<boolean>();
export const focusedField = StateField.define<boolean>({
  create: () => false,
  update(value, tr) { for (const effect of tr.effects) if (effect.is(editorFocused)) value = effect.value; return value; },
});
export const sourceBlock = StateField.define<{ from: number; to: number } | null>({
  create: () => null,
  update(value, tr) {
    if (value) value = { from: tr.changes.mapPos(value.from), to: tr.changes.mapPos(value.to, 1) };
    for (const effect of tr.effects) if (effect.is(revealBlock)) value = effect.value;
    return value;
  },
});

class RenderWidget extends WidgetType {
  constructor(readonly projection: Projection, readonly block: boolean) { super(); }
  eq(other: RenderWidget) {
    const a = this.projection, b = other.projection;
    return a.kind === b.kind && a.from === b.from && a.to === b.to && a.source === b.source && a.tableDocument === b.tableDocument && a.renderSource === b.renderSource && a.containerPrefix === b.containerPrefix && a.definitions === b.definitions && a.footnoteNumbers === b.footnoteNumbers;
  }
  toDOM(view: EditorView) {
    const element = document.createElement(this.block ? 'div' : 'span');
    element.className = `md-projection md-projection-${this.projection.kind}`;
    this.decorateContainer(element);
    if (this.block) element.style.minHeight = `${this.estimatedHeight}px`;
    view.state.facet(projectionHost).mount(element, this.projection, view);
    return element;
  }
  updateDOM(element: HTMLElement, view: EditorView) {
    if (!element.classList.contains(`md-projection-${this.projection.kind}`)) return false;
    this.decorateContainer(element);
    view.state.facet(projectionHost).mount(element, this.projection, view);
    return true;
  }
  decorateContainer(element: HTMLElement) {
    const prefix = this.projection.containerPrefix ?? '';
    element.classList.toggle('md-projection-quoted', prefix.includes('>'));
    const marker = /([-+*]|\d+[.)])\s*$/.exec(prefix)?.[1];
    if (marker) element.dataset.listMarker = /[-+*]/.test(marker) ? '•' : marker;
    else delete element.dataset.listMarker;
  }
  destroy(element: HTMLElement) { widgetHosts.get(element)?.unmount(element); widgetHosts.delete(element); }
  ignoreEvent() { return true; }
  get estimatedHeight() {
    if (!this.block) return -1;
    if (this.projection.kind === 'CodeHeader') return 28;
    if (this.projection.kind === 'Image') return 180;
    if (this.projection.kind === 'Table') return 360;
    let lines = 1, at = -1;
    while (lines < 14 && (at = this.projection.source.indexOf('\n', at + 1)) >= 0) lines++;
    return Math.min(360, Math.max(52, lines * 26));
  }
}
// Weak ownership lets CM's widget.destroy release portal resources even after
// an EditorState reconfiguration removed the facet that created the widget.
export const widgetHosts = new WeakMap<HTMLElement, ProjectionHost>();

class CheckboxWidget extends WidgetType {
  constructor(readonly from: number, readonly checked: boolean) { super(); }
  eq(other: CheckboxWidget) { return this.from === other.from && this.checked === other.checked; }
  toDOM(view: EditorView) {
    const input = document.createElement('input'); input.type = 'checkbox'; input.className = 'md-task-checkbox';
    this.updateDOM(input, view);
    return input;
  }
  updateDOM(element: HTMLElement, view: EditorView) {
    const input = element as HTMLInputElement; input.checked = this.checked;
    input.setAttribute('aria-label', view.state.sliceDoc(this.from + 3, view.state.doc.lineAt(this.from).to).trim());
    input.onchange = () => view.dispatch({ changes: { from: this.from + 1, to: this.from + 2, insert: input.checked ? 'x' : ' ' }, userEvent: 'input.task' });
    input.onfocus = () => view.dispatch({ selection: { anchor: this.from } });
    return true;
  }
  ignoreEvent() { return true; }
}
class BulletWidget extends WidgetType {
  eq() { return true; }
  toDOM() { const bullet = document.createElement('span'); bullet.textContent = '•'; bullet.className = 'md-list-bullet'; return bullet; }
  ignoreEvent() { return false; }
}

function project(state: EditorState, from: number, to: number): DecorationSet {
  const ranges: { from: number; to: number; value: Decoration }[] = [];
  const active = state.selection.ranges;
  const raw = state.field(sourceBlock);
  const selected = (a: number, b: number) => state.field(focusedField) && active.some(range => range.from <= b && range.to >= a);
  const isRaw = (a: number, b: number) => raw && raw.from < b && raw.to > a;
  const add = (a: number, b: number, value: Decoration) => ranges.push({ from: a, to: b, value });
  const hidden = (a: number, b: number) => { if (b > a) add(a, b, Decoration.replace({})); };
  const lines = new Set<string>();
  const inlineHTML: { from: number; to: number }[] = [];
  const lineStyle = (position: number, className: string) => {
    const start = state.doc.lineAt(position).from, key = `${start}:${className}`;
    if (!lines.has(key)) { lines.add(key); add(start, start, Decoration.line({ class: className })); }
  };
  if (raw && raw.from <= to && raw.to >= from) {
    const end = Math.min(raw.to, to);
    for (let line = state.doc.lineAt(Math.max(raw.from, from)); line.from <= end;) {
      lineStyle(line.from, 'md-local-source-line');
      if (line.to >= end) break;
      line = state.doc.lineAt(line.to + 1);
    }
  }
  syntaxTree(state).iterate({ from, to, enter(node) {
    const { from: a, to: b } = node;
    if (inlineHTML.some(range => a >= range.from && b <= range.to)) return false;
    const name = node.name === 'LiveTable' ? 'Table' : node.name;
    const text = () => state.sliceDoc(a, b);
    if (name === 'Paragraph') {
      const stack: { tag: string; from: number }[] = [];
      for (const tagNode of node.node.getChildren('HTMLTag')) {
        const tag = /^<(\/?)([a-z][\w-]*)\b/i.exec(state.sliceDoc(tagNode.from, tagNode.to));
        if (!tag) continue;
        const tagName = tag[2].toLowerCase();
        let range: { from: number; to: number } | undefined;
        if (tag[1]) {
          if (stack.at(-1)?.tag !== tagName) continue;
          const opening = stack.pop()!;
          if (!stack.length) range = { from: opening.from, to: tagNode.to };
        } else if (/^(?:br|img|input|hr|wbr)$/.test(tagName) || /\/>$/.test(state.sliceDoc(tagNode.from, tagNode.to))) {
          if (!stack.length) range = { from: tagNode.from, to: tagNode.to };
        } else stack.push({ tag: tagName, from: tagNode.from });
        if (range && !selected(range.from, range.to) && !isRaw(range.from, range.to)) {
          inlineHTML.push(range);
          add(range.from, range.to, Decoration.replace({ widget: new RenderWidget({ kind: 'InlineHTML', ...range, source: state.sliceDoc(range.from, range.to), definitions: state.field(definitions).source }, false) }));
        }
      }
    }
    const standaloneImage = name === 'Image' && node.node.parent?.name === 'Paragraph' && node.node.parent.from === a && node.node.parent.to === b;
    const block = standaloneImage || ['Table', 'Frontmatter', 'MathBlock', 'HTMLBlock', 'FootnoteDefinition', 'LinkReference', 'HorizontalRule'].includes(name) || name === 'FencedCode' && /^`{3,}mermaid\b|^~{3,}mermaid\b/.test(text());
    const complete = name === 'MathBlock' ? node.node.getChildren('MathMark').length === 2 : name !== 'Frontmatter' || /\n(?:---|\.\.\.)\s*$/.test(text());
    if (block && complete && !isRaw(a, b) && (name === 'Table' || !selected(a, b))) {
      // Table input lives in a cell projection. A parent cursor alone must not
      // turn the entire table into source (explicit source action does).
      const renderSource = name === 'MathBlock' ? '$$\n' + node.node.getChildren('MathText').map(part => state.sliceDoc(part.from, part.to)).join('\n') + '\n$$' : undefined;
      const lineStart = state.doc.lineAt(a).from, prefix = state.sliceDoc(lineStart, a);
      const blockStart = /^[\s>]*(?:(?:[-+*]|\d+[.)])\s+)?$/.test(prefix) ? lineStart : a;
      if (blockStart < a) {
        for (let index = ranges.length - 1; index >= 0; index--) if (ranges[index].from >= blockStart && ranges[index].to <= a) ranges.splice(index, 1);
      }
      add(blockStart, b, Decoration.replace({ block: true, widget: new RenderWidget({ kind: name, from: a, to: b, source: name === 'Table' ? '' : text(), tableDocument: name === 'Table' ? state.doc : undefined, renderSource, containerPrefix: blockStart < a ? prefix : undefined, definitions: state.field(definitions).source, footnoteNumbers: state.field(definitions).footnoteNumbers }, true) }));
      return false;
    }
    if ((['Image', 'InlineMath', 'FootnoteReference'].includes(name) || name === 'Link' && !node.node.getChild('URL')) && !selected(a, b) && !isRaw(a, b)) {
      add(a, b, Decoration.replace({ widget: new RenderWidget({ kind: name, from: a, to: b, source: text(), definitions: state.field(definitions).source, footnoteNumbers: state.field(definitions).footnoteNumbers }, false) }));
      return false;
    }
    if (/^(ATX|Setext)Heading/.test(name)) {
      const level = Number(name.at(-1)); lineStyle(a, `md-heading md-h${level}`);
    }
    if (name === 'QuoteMark') lineStyle(a, 'md-quote');
    let quoted = false;
    if (name === 'Paragraph' || name === 'FencedCode' || name === 'CodeBlock') {
      for (let parent = node.node.parent; parent; parent = parent.parent) if (parent.name === 'Blockquote') { quoted = true; break; }
    }
    // Style visible text leaves, not every physical line of a composite
    // quote. A single projected table can span hundreds of thousands of lines.
    if (quoted && name === 'Paragraph') {
      for (let line = state.doc.lineAt(Math.max(a, from)); line.from <= Math.min(b, to);) {
        lineStyle(line.from, 'md-quote');
        if (line.number === state.doc.lines) break;
        line = state.doc.line(line.number + 1);
      }
    }
    if (name === 'FencedCode' || name === 'CodeBlock') {
      if (!isRaw(a, b)) add(a, a, Decoration.widget({ block: true, side: -1, widget: new RenderWidget({ kind: 'CodeHeader', from: a, to: b, source: text() }, true) }));
      for (let line = state.doc.lineAt(Math.max(a, from)); line.from <= Math.min(b, to);) {
        lineStyle(line.from, 'md-code-line');
        if (line.to >= b) lineStyle(line.from, 'md-code-last');
        if (name === 'FencedCode' && !selected(a, b) && !isRaw(a, b) && node.node.getChildren('CodeMark').some(mark => mark.from >= line.from && mark.from <= line.to)) lineStyle(line.from, line.from === state.doc.lineAt(b).from ? 'md-code-fence md-code-end' : 'md-code-fence');
        if (quoted) lineStyle(line.from, 'md-quote');
        if (line.number === state.doc.lines) break;
        line = state.doc.line(line.number + 1);
      }
      return true;
    }
    const inlineClass: Record<string, string> = { StrongEmphasis: 'md-strong', Emphasis: 'md-emphasis', Strikethrough: 'md-strike', InlineCode: 'md-inline-code', Link: 'md-link', Autolink: 'md-link' };
    if (inlineClass[name]) add(a, b, Decoration.mark({ class: inlineClass[name] }));
    if (name === 'TaskMarker' && !isRaw(a, b)) {
      add(a, b, Decoration.replace({ widget: new CheckboxWidget(a, /[xX]/.test(text())) })); return false;
    }
    const parent = node.node.parent;
    const parentActive = parent && selected(parent.from, parent.to);
    if (name === 'ListMark' && !selected(state.doc.lineAt(a).from, state.doc.lineAt(a).to)) {
      if (/^\s+\[[ xX]\]/.test(state.sliceDoc(b, Math.min(b + 6, state.doc.length)))) hidden(a, Math.min(b + 1, state.doc.length));
      else if (/[-+*]/.test(text())) add(a, b, Decoration.replace({ widget: new BulletWidget() }));
      else add(a, b, Decoration.mark({ class: 'md-list-marker' }));
    }
    if (['HeaderMark', 'EmphasisMark', 'StrikethroughMark', 'CodeMark', 'QuoteMark', 'LinkMark', 'CodeInfo'].includes(name) && !parentActive && !isRaw(a, b)) hidden(a, ['HeaderMark', 'QuoteMark'].includes(name) && state.sliceDoc(b, b + 1) === ' ' ? b + 1 : b);
    if ((name === 'URL' || name === 'LinkTitle') && parent?.name === 'Link' && !parentActive && !isRaw(a, b)) hidden(a, b);
    return true;
  } });
  ranges.sort((a, b) => a.from - b.from || a.value.startSide - b.value.startSide || a.to - b.to);
  const builder = new RangeSetBuilder<Decoration>();
  for (const range of ranges) builder.add(range.from, range.to, range.value);
  return builder.finish();
}

const projectionField = StateField.define<{ from: number; to: number; composing: boolean; decorations: DecorationSet }>({
  create(state) { const to = Math.min(state.doc.length, 4000); return { from: 0, to, composing: false, decorations: project(state, 0, to) }; },
  update(value, tr) {
    let from = tr.changes.mapPos(value.from), to = tr.changes.mapPos(value.to, 1), inComposition = value.composing;
    for (const effect of tr.effects) {
      if (effect.is(visibleRegion)) { from = effect.value.from; to = effect.value.to; }
      if (effect.is(composing)) inComposition = effect.value;
    }
    const relevant = tr.docChanged || tr.selection || tr.effects.length || syntaxTree(tr.state) !== syntaxTree(tr.startState);
    return { from, to, composing: inComposition, decorations: inComposition ? value.decorations.map(tr.changes) : relevant ? project(tr.state, from, to) : value.decorations };
  },
  provide: field => EditorView.decorations.from(field, value => value.decorations),
});

export function livePreview(): Extension {
  return [projectionField, ViewPlugin.fromClass(class {
    pending = false; destroyed = false;
    readonly onScroll = () => this.schedule();
    constructor(readonly view: EditorView) { view.scrollDOM.addEventListener('scroll', this.onScroll, { passive: true }); this.schedule(); }
    update(update: ViewUpdate) { if (update.viewportChanged || update.geometryChanged) this.schedule(); }
    schedule() {
      if (this.pending) return; this.pending = true;
      this.view.requestMeasure({
        key: this,
        read: () => {
          if (this.destroyed) return null;
          const { doc } = this.view.state, viewport = this.view.viewport;
          // CM's viewport includes entire wrapped physical lines. Resolve visual
          // rows inside CM's read phase: idle posAtCoords forces another measure,
          // and changed inline widths can otherwise create a microtask feedback loop.
          const bounds = this.view.scrollDOM.getBoundingClientRect();
          const top = bounds.height ? this.view.posAtCoords({ x: bounds.left + 24, y: bounds.top + 2 }) : null;
          const bottom = bounds.height ? this.view.posAtCoords({ x: bounds.right - 24, y: bounds.bottom - 2 }) : null;
          return { doc, from: Math.min(top ?? viewport.from, bottom ?? viewport.to), to: Math.max(top ?? viewport.from, bottom ?? viewport.to) };
        },
        write: region => {
          // Transactions cannot run during CM's measure/update cycle. Keep this
          // request pending through that cycle, then commit the measured projection.
          queueMicrotask(() => {
            this.pending = false;
            if (this.destroyed || !region) return;
            if (this.view.state.doc !== region.doc) { this.schedule(); return; }
            const current = this.view.state.field(projectionField), { from, to } = region;
            if (from >= current.from && to <= current.to && current.to - current.from <= to - from + 2000) return;
            this.view.dispatch({ effects: visibleRegion.of({ from: Math.max(0, from - 512), to: Math.min(region.doc.length, to + 512) }) });
          });
        },
      });
    }
    destroy() { this.destroyed = true; this.view.scrollDOM.removeEventListener('scroll', this.onScroll); }
  })];
}
