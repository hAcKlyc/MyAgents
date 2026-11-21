import { createElement, Fragment } from 'react';
import { refractor } from 'refractor/all';
import type { RootContent } from 'hast';
import { createElement as createSyntaxElement, type SyntaxHighlighterProps } from 'react-syntax-highlighter';

type Renderer = NonNullable<SyntaxHighlighterProps['renderer']>;
type Cut = { index: number; line: number };
type Snapshot = {
  tokens: RootContent[];
  cuts: Cut[];
  elements: React.ReactNode[];
  rowStarts: Map<number, number>;
  groups: React.ReactElement[];
};

// Fragments keep the original inline DOM (and native selections) while letting
// React skip groups whose actual token elements are all still identical.
const GROUP_SIZE = 128;
function groupElements(elements: React.ReactNode[], reusable: number, previous?: Snapshot) {
  const groups = previous?.groups.slice(0, Math.floor(reusable / GROUP_SIZE)) ?? [];
  for (let i = groups.length * GROUP_SIZE; i < elements.length; i += GROUP_SIZE) {
    groups.push(createElement(Fragment, { key: i }, elements.slice(i, i + GROUP_SIZE)));
  }
  return groups;
}

export const renderFinishedHighlight: Renderer = ({ rows, stylesheet, useInlineStyles }) =>
  groupElements(rows.map((node, i) => createSyntaxElement({
    node, stylesheet, useInlineStyles, key: `code-segment-${i}`,
  })), 0);

// Refractor emits spans with ordered class names and text leaves. Unrecognized
// HAST properties force a fresh render, even when the original text is equal.
function sameToken(a: RootContent, b: RootContent): boolean {
  if (a.type === 'text' && b.type === 'text') return a.value === b.value;
  if (a.type !== 'element' || b.type !== 'element' || a.tagName !== b.tagName ||
      a.children.length !== b.children.length) return false;
  const ac = a.properties.className, bc = b.properties.className;
  if (!Array.isArray(ac) || !Array.isArray(bc) || ac.length !== bc.length) return false;
  for (const key in a.properties) if (key !== 'className') return false;
  for (const key in b.properties) if (key !== 'className') return false;
  for (let i = 0; i < ac.length; i++) if (ac[i] !== bc[i]) return false;
  for (let i = 0; i < a.children.length; i++) if (!sameToken(a.children[i], b.children[i])) return false;
  return true;
}

function countBreaks(node: RootContent): number {
  if (node.type === 'element') return node.children.reduce((sum, child) => sum + countBreaks(child), 0);
  if (node.type !== 'text') return 0;
  let count = 0;
  for (let pos = node.value.indexOf('\n'); pos >= 0; pos = node.value.indexOf('\n', pos + 1)) count++;
  return count;
}

export function createStreamingHighlight(language: string, stylesheet: NonNullable<SyntaxHighlighterProps['style']>) {
  let previous: Snapshot | undefined;
  return (source: string) => {
    const tokens = refractor.highlight(source, language).children;
    const prior = previous;
    let equal = 0;
    if (prior) while (equal < tokens.length && equal < prior.tokens.length && sameToken(tokens[equal], prior.tokens[equal])) equal++;

    // Only split on an unstyled token containing one newline that still has a successor.
    // Feeding the newline itself back through the normal renderer preserves the
    // empty leading span it emits at the start of the next line.
    let cut: Cut | undefined;
    if (prior) {
      for (let i = prior.cuts.length - 1; i >= 0; i--) {
        const candidate = prior.cuts[i];
        if (candidate.index < equal && candidate.index + 1 < tokens.length && prior.rowStarts.has(candidate.line + 1)) {
          cut = candidate;
          break;
        }
      }
    }
    const start = cut?.index ?? 0;
    let line = cut?.line ?? 1;
    const cuts = prior && cut ? prior.cuts.filter(item => item.index < start) : [];
    for (let i = start; i < tokens.length; i++) {
      const token = tokens[i];
      if (token.type === 'text' && token.value.includes('\n') && token.value.indexOf('\n') === token.value.lastIndexOf('\n')) cuts.push({ index: i, line });
      line += countBreaks(token);
    }
    const startingLineNumber = cut?.line ?? 1;
    const tree = { type: 'root', children: cut ? tokens.slice(start) : tokens };
    const renderer: Renderer = ({ rows, useInlineStyles }) => {
      const prefix = prior && cut ? prior.rowStarts.get(cut.line + 1)! : 0;
      const elements = prior && prefix ? prior.elements.slice(0, prefix) : [];
      const rowStarts = new Map<number, number>();
      if (prior && prefix) for (const [number, index] of prior.rowStarts) {
        if (index >= prefix) break;
        rowStarts.set(number, index);
      }
      // The partial line consists exactly of its inline line number and newline.
      for (let i = cut ? 2 : 0; i < rows.length; i++) {
        const node = rows[i];
        if (node.properties?.className.includes('react-syntax-highlighter-line-number')) {
          rowStarts.set(Number(node.children?.[0]?.value), elements.length);
        }
        elements.push(createSyntaxElement({ node, stylesheet, useInlineStyles, key: `code-segment-${elements.length}` }));
      }
      const groups = groupElements(elements, prefix, prior);
      previous = { tokens, cuts, elements, rowStarts, groups };
      return groups;
    };
    return { astGenerator: { highlight: () => tree }, startingLineNumber, renderer };
  };
}
