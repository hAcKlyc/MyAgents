// Store offsets and weak references so suspending a Tab cannot retain a discarded row.
export interface ChatReadingAnchor {
  block: string;
  source?: string;
  sourceTop?: number;
  codeLine?: { number: number; tokenOffset: number };
  offset: number;
  text: string;
  node: WeakRef<Text>;
  top: number;
  blockTop: number;
}

function characterRect(node: Text, offset: number) {
  if (offset < 0 || offset >= node.length) return null;
  const range = document.createRange();
  range.setStart(node, offset);
  range.setEnd(node, offset + 1);
  const rect = range.getBoundingClientRect();
  return rect.height > 0 ? rect : null;
}

const lineNumberClass = 'react-syntax-highlighter-line-number';

function locateCodeLine(node: Text) {
  const code = node.parentElement?.closest('pre code');
  if (!code) return;
  let token = node.parentElement;
  while (token && token.parentElement !== code) token = token.parentElement;
  for (let offset = 0; token && offset < 128; offset++, token = token.previousElementSibling as HTMLElement | null) {
    if (token.classList.contains(lineNumberClass)) return { number: Number(token.textContent), tokenOffset: offset };
  }
}

export function captureReadingAnchor(scope: HTMLElement, viewport: DOMRect): ChatReadingAnchor | undefined {
  const doc = scope.ownerDocument as Document & {
    caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null;
    caretRangeFromPoint?: (x: number, y: number) => Range | null;
  };
  const x = viewport.left + viewport.width / 2;
  const y = viewport.top + Math.min(16, viewport.height / 2);
  const position = doc.caretPositionFromPoint?.(x, y);
  const range = position ? null : doc.caretRangeFromPoint?.(x, y);
  const node = position?.offsetNode ?? range?.startContainer;
  if (!(node instanceof Text) || !scope.contains(node) || !node.length) return;
  const block = node.parentElement?.closest<HTMLElement>('[data-chat-block]');
  if (!block || !scope.contains(block)) return;
  const offset = Math.min(position?.offset ?? range!.startOffset, node.length - 1);
  const rect = characterRect(node, offset);
  if (!rect || rect.bottom < viewport.top || rect.top > y + rect.height) return;
  const sourceElement = node.parentElement?.closest<HTMLElement>('[data-chat-source]');
  const source = sourceElement?.dataset.chatSource;
  return { block: block.dataset.chatBlock!, source, sourceTop: sourceElement ? sourceElement.getBoundingClientRect().top - viewport.top : undefined,
    codeLine: locateCodeLine(node), offset, text: node.data.slice(Math.max(0, offset - 12), offset + 13),
    node: new WeakRef(node), top: rect.top - viewport.top, blockTop: block.getBoundingClientRect().top - viewport.top };
}

export function readingAnchorDelta(scope: HTMLElement, anchor: ChatReadingAnchor, viewportTop: number): number | null {
  const block = scope.querySelector<HTMLElement>(`[data-chat-block="${CSS.escape(anchor.block)}"]`);
  if (!block) return null;
  const old = anchor.node.deref();
  const matches = (node: Text) => node.length > anchor.offset &&
    node.data.slice(Math.max(0, anchor.offset - 12), anchor.offset + 13) === anchor.text;
  let node = old && block.contains(old) && matches(old) ? old : null;
  const source = !node && anchor.source !== undefined
    ? block.querySelector(`[data-chat-source="${CSS.escape(anchor.source)}"]`) : null;
  if (source) {
    if (anchor.codeLine) {
      const { number, tokenOffset } = anchor.codeLine;
      let token: Element | null = source.getElementsByClassName(lineNumberClass).item(number - 1);
      if (token?.textContent === String(number)) {
        for (let i = 0; token && i < tokenOffset; i++) token = token.nextElementSibling;
        const candidate = token?.firstChild;
        if (candidate instanceof Text && matches(candidate)) node = candidate;
      }
    } else {
      const walker = document.createTreeWalker(source, NodeFilter.SHOW_TEXT);
      // Ambiguous or very fragmented Markdown falls back to the containing block.
      let current: Node | null;
      let visited = 0;
      while ((current = walker.nextNode())) {
        if (++visited > 64) { node = null; break; }
        if (!matches(current as Text)) continue;
        if (node) { node = null; break; }
        node = current as Text;
      }
    }
  }
  const rect = node && characterRect(node, anchor.offset);
  if (rect) return rect.top - viewportTop - anchor.top;
  if (source && anchor.sourceTop !== undefined) return source.getBoundingClientRect().top - viewportTop - anchor.sourceTop;
  return block.getBoundingClientRect().top - viewportTop - anchor.blockTop;
}
