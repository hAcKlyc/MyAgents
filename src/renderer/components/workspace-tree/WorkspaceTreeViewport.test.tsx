import { act, render, waitFor } from "@testing-library/react";
import { StrictMode, type ComponentProps, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { DirectoryTreeNode } from "../../../shared/dir-types";
import type { TreeListItem, VisibleTreeRow } from "./treeTypes";
import { WorkspaceTreeViewport } from "./WorkspaceTreeViewport";

const mocks = vi.hoisted(() => ({
  scrollToIndex: vi.fn(),
  scrollerHeight: 200,
  contentHeight: 0,
  scroller: null as HTMLElement | null,
  publishListHeight: null as ((height: number) => void) | null,
  resize: null as ResizeObserverCallback | null,
}));

vi.mock("react-virtuoso", async () => {
  const React = await import("react");
  return {
    Virtuoso: React.forwardRef(function MockVirtuoso(
      props: {
        data: TreeListItem[];
        itemContent: (index: number, row: TreeListItem) => ReactNode;
        scrollerRef?: (element: HTMLElement | null) => void;
        totalListHeightChanged?: (height: number) => void;
      },
      ref,
    ) {
      const { data, itemContent, scrollerRef } = props;
      React.useEffect(() => {
        mocks.publishListHeight = props.totalListHeightChanged ?? null;
        return () => {
          mocks.publishListHeight = null;
        };
      }, [props.totalListHeightChanged]);
      React.useImperativeHandle(ref, () => ({
        scrollToIndex: mocks.scrollToIndex,
      }));
      React.useEffect(() => {
        const element = document.createElement("div");
        Object.defineProperty(element, "clientHeight", {
          configurable: true,
          get: () => mocks.scrollerHeight,
        });
        Object.defineProperty(element, "scrollHeight", {
          get: () => Math.max(mocks.contentHeight, mocks.scrollerHeight),
        });
        mocks.scroller = element;
        scrollerRef?.(element);
        return () => scrollerRef?.(null);
      }, [scrollerRef]);

      return (
        <div>
          {data.map((row, index) => (
            <div key={row.key}>{itemContent(index, row)}</div>
          ))}
        </div>
      );
    }),
  };
});

vi.mock("./WorkspaceTreeRow", () => ({
  WorkspaceTreeRow: ({ row }: { row: VisibleTreeRow }) => (
    <div data-testid={`row-${row.path}`}>{row.path}</div>
  ),
}));

vi.mock("./WorkspaceTreeStickyAncestors", () => ({
  WorkspaceTreeStickyAncestors: () => null,
}));

function treeRow(path: string, isDir: boolean): VisibleTreeRow {
  const name = path.split("/").pop() ?? path;
  const data: DirectoryTreeNode = {
    id: path,
    name,
    path,
    type: isDir ? "dir" : "file",
  };
  return {
    data,
    depth: path.includes("/") ? 1 : 0,
    isDir,
    isLoading: false,
    isOpen: false,
    isSelected: false,
    parentPath: null,
    path,
  };
}

function treeItems(paths: string[], isDir = true) {
  return paths.map((p) => {
    const row = treeRow(p, isDir);
    return { kind: "node" as const, key: row.path, row };
  });
}

function renderViewport(
  overrides: Partial<ComponentProps<typeof WorkspaceTreeViewport>> = {},
  strict = false,
) {
  const onRevealHandled = vi.fn();
  const props = {
    items: treeItems(
      Array.from({ length: 600 }, (_, index) => `folder-${index}`),
    ),
    revealRequest: { id: 7, path: "folder-500" },
    ...overrides,
  };
  const view = (next = props) => {
    const viewport = (
      <WorkspaceTreeViewport
        rowHeight={26}
        dropTargetPath={null}
        internalDropTarget={null}
        activeDragPaths={[]}
        cutPaths={[]}
        focusedPath={null}
        treeActive={false}
        onRevealHandled={onRevealHandled}
        getStickyAncestors={() => []}
        onCloseAncestorPath={vi.fn()}
        onJumpToAncestorPath={vi.fn()}
        onAncestorContextMenu={vi.fn()}
        onRowClick={vi.fn()}
        onRowContextMenu={vi.fn()}
        onEditCommit={vi.fn()}
        onEditCancel={vi.fn()}
        {...next}
      />
    );
    return strict ? <StrictMode>{viewport}</StrictMode> : viewport;
  };
  const rendered = render(view());
  return {
    onRevealHandled,
    ...rendered,
    update: (next: typeof props) => rendered.rerender(view(next)),
    props,
  };
}

async function publishLayout(height = 600 * 26 + 78) {
  await act(async () => {
    mocks.contentHeight = height;
    mocks.publishListHeight?.(height);
    mocks.resize?.([], {} as ResizeObserver);
  });
}

describe("WorkspaceTreeViewport reveal request", () => {
  beforeEach(() => {
    mocks.scrollToIndex.mockClear();
    mocks.scrollerHeight = 200;
    mocks.contentHeight = 0;
    mocks.resize = null;
    vi.stubGlobal(
      "ResizeObserver",
      class {
        constructor(callback: ResizeObserverCallback) {
          mocks.resize = callback;
        }
        observe() {}
        disconnect() {}
      },
    );
    mocks.scrollToIndex.mockImplementation(({ index }: { index: number }) => {
      const element = mocks.scroller!;
      // A real browser clamps scrollTo while the virtual content is absent.
      element.scrollTop = Math.max(
        0,
        Math.min(
          mocks.contentHeight - element.clientHeight,
          index * 26 - (element.clientHeight - 26) / 2,
        ),
      );
    });
  });

  afterEach(() => vi.unstubAllGlobals());

  // The browser has a viewport height before the virtual list commits its
  // content height. A command issued in that gap is clamped to scrollTop=0.
  it.each([false, true])(
    "keeps a reveal pending until virtual content is laid out (StrictMode: %s)",
    async (strict) => {
      const { onRevealHandled } = renderViewport({}, strict);

      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 60));
      });
      expect(onRevealHandled).not.toHaveBeenCalled();
      expect(mocks.scroller?.scrollTop).toBe(0);
      await publishLayout();

      await waitFor(() => {
        expect(mocks.scrollToIndex).toHaveBeenCalledWith({
          index: 500,
          align: "center",
          behavior: "auto",
        });
      });
      await waitFor(() =>
        expect(onRevealHandled).toHaveBeenCalledExactlyOnceWith(7),
      );
      expect(mocks.scroller!.scrollTop).toBeGreaterThan(12000);
    },
  );

  it("keeps a hidden reveal pending and resumes when the viewport becomes visible", async () => {
    mocks.scrollerHeight = 0;
    const { onRevealHandled } = renderViewport();
    await publishLayout();
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 400));
    });
    expect(onRevealHandled).not.toHaveBeenCalled();
    expect(mocks.scrollToIndex).not.toHaveBeenCalled();

    mocks.scrollerHeight = 200;
    await publishLayout();

    await waitFor(() => {
      expect(onRevealHandled).toHaveBeenCalledWith(7);
    });
    expect(mocks.scroller!.scrollTop).toBeGreaterThan(12000);
  });

  it("only handles the latest request after a lazy list update", async () => {
    const view = renderViewport();
    view.update({
      ...view.props,
      items: treeItems(["a.md", "dir/b.md"], false),
      revealRequest: { id: 8, path: "dir/b.md" },
    });
    await publishLayout(2 * 26 + 78);
    await waitFor(() =>
      expect(view.onRevealHandled).toHaveBeenCalledExactlyOnceWith(8),
    );
  });

  it("handles another reveal of the same path after the user scrolls away", async () => {
    const view = renderViewport();
    await publishLayout();
    await waitFor(() => expect(view.onRevealHandled).toHaveBeenCalledWith(7));
    mocks.scroller!.scrollTop = 0;
    view.update({
      ...view.props,
      revealRequest: { id: 8, path: "folder-500" },
    });
    await waitFor(() =>
      expect(view.onRevealHandled).toHaveBeenLastCalledWith(8),
    );
    expect(view.onRevealHandled).toHaveBeenCalledTimes(2);
    expect(mocks.scroller!.scrollTop).toBeGreaterThan(12000);
  });

  it("cancels a reveal when the request is cleared before layout", async () => {
    const view = renderViewport();
    view.update({ ...view.props, revealRequest: null });
    await publishLayout();
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 60));
    });
    expect(view.onRevealHandled).not.toHaveBeenCalled();
    expect(mocks.scrollToIndex).not.toHaveBeenCalled();
  });
});
