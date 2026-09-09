import { EditorState } from '@codemirror/state';
import { describe, expect, it } from 'vitest';
import { markdownSyntax } from './syntax';
import { definitions } from './definitions';
import { syntaxTree } from '@codemirror/language';

describe('Markdown document context', () => {
  it('indexes references and multiline footnotes while excluding code examples', () => {
    const source = 'Body [r] and [^n].\n\n[r]: /notes.md\n[^n]: first\n    continuation\n\n```md\n[bad]: /bad\n```\n';
    const state = EditorState.create({ doc: source, extensions: [markdownSyntax(), definitions] });
    expect(state.field(definitions).source).toBe('[r]: /notes.md\n\n[^n]: first\n    continuation');
    expect(syntaxTree(state).toString()).toContain('FootnoteDefinition');
  });
  it('updates an edited definition without losing distant reference context', () => {
    let state = EditorState.create({ doc: '[a]: /one\n\nbody\n\n[b]: /two', extensions: [markdownSyntax(), definitions] });
    state = state.update({ changes: { from: 6, to: 9, insert: 'changed' } }).state;
    expect(state.field(definitions).source).toBe('[a]: /changed\n\n[b]: /two');
    state = state.update({ changes: { from: 0, to: state.doc.line(1).to + 1 } }).state;
    expect(state.field(definitions).source).toBe('[b]: /two');
  });
  it('uses parser semantics for nested definitions, table rows and first-use footnote numbering', () => {
    const source = 'Text [^b] and [^a], again [^b].\n\n> [r]: /nested\n> [^a]: quoted note\n>     continuation\n\n[^b]: another note\n\n| Header |\n| --- |\n[fake]: /inside-table\n';
    const state = EditorState.create({ doc: source, extensions: [markdownSyntax(), definitions] });
    const context = state.field(definitions);
    expect(context.source).toContain('[r]: /nested');
    expect(context.source).toContain('[^a]: quoted note\n    continuation');
    expect(context.source).not.toContain('fake');
    expect([...context.footnoteNumbers]).toEqual([['b', 1], ['a', 2]]);
  });
  it('updates context when a syntax boundary turns definitions into code', () => {
    let state = EditorState.create({ doc: '[r]: /target\n\nText [^a]\n\n[^a]: note', extensions: [markdownSyntax(), definitions] });
    state = state.update({ changes: { from: 0, insert: '```md\n' } }).state;
    expect(state.field(definitions).source).toBe('');
    expect(state.field(definitions).footnotes.size).toBe(0);
  });

});
