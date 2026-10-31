import {
  act,
  fireEvent,
  render,
  screen,
  renderHook,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkspaceFileService } from "@/hooks/useWorkspaceFileService";
const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  thoughts: vi.fn(),
  thoughtsAvailable: true,
  snapshot: {
    authGeneration: 0,
    principalId: null as string | null,
    networkId: null as string | null,
    state: "signedOut",
    revision: 0,
  },
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("@/api/taskCenter", () => ({
  thoughtListPage: mocks.thoughts,
  taskCenterAvailable: () => mocks.thoughtsAvailable,
}));
vi.mock("@/features/agent-network/store", () => ({
  useAgentNetworkSnapshot: () => mocks.snapshot,
  useAgentNetworkDirectoryVersion:()=>JSON.stringify([mocks.snapshot.authGeneration,mocks.snapshot.principalId,mocks.snapshot.networkId]),
}));
import { useMentionPicker } from "./useMentionPicker";
import { MentionPicker } from "../components/MentionPicker";
function PickerView({ query }: { query: string }) {
  const picker = useMentionPicker(true, query, "/ws", files);
  return (
    <MentionPicker
      picker={picker}
      query={query}
      onChoose={() => {}}
      onKeyDown={() => {}}
    />
  );
}
const page = <T,>(items: T[], nextCursor: string | null = null) => ({
  items,
  nextCursor,
  hasMore: Boolean(nextCursor),
  complete: !nextCursor,
  scanLimitReached: false,
});
const files = {
  isAvailable: true,
  searchFilesPage: vi.fn(),
} as unknown as WorkspaceFileService;
const discovery = {
  items: [
    {
      selector: "local",
      name: "Local Agent",
      isLocal: true,
      deviceId: null,
      deviceName: null,
      platform: null,
      description: null,
      source: null,
    },
  ],
  complete: true,
  networkStatus: "signedOut",
  authGeneration: 0,
  principalId: null,
  networkId: null,
};
beforeEach(() => {
  mocks.snapshot = {
    authGeneration: 0,
    principalId: null,
    networkId: null,
    state: "signedOut",
    revision: 0,
  };
  mocks.thoughtsAvailable = true;
  mocks.invoke.mockResolvedValue(discovery);
  mocks.thoughts.mockResolvedValue(page([]));
  vi.mocked(files.searchFilesPage).mockResolvedValue(
    page(
      Array.from({ length: 8 }, (_, i) => ({
        name: `${i}.txt`,
        path: `${i}.txt`,
        type: "file" as const,
      })),
    ),
  );
});
afterEach(() => vi.clearAllMocks());
describe("unified mention picker", () => {
  it("never queries or exposes files for an empty mention, including keyboard choices", async () => {
    const { result, rerender } = renderHook(
      ({ query }) => useMentionPicker(true, query, "/ws", files),
      { initialProps: { query: "" } },
    );
    await waitFor(() =>
      expect(result.current.groups.every((group) => !group.loading)).toBe(true),
    );
    expect(result.current.groups.map((group) => group.kind)).toEqual([
      "agent",
      "thought",
    ]);
    expect(
      result.current.allOptions.some((option) => option.kind === "file"),
    ).toBe(false);
    expect(files.searchFilesPage).not.toHaveBeenCalled();
    rerender({ query: "txt" });
    await waitFor(() => expect(files.searchFilesPage).toHaveBeenCalledTimes(1));
    rerender({ query: "" });
    await waitFor(() =>
      expect(result.current.groups.every((group) => !group.loading)).toBe(true),
    );
    expect(result.current.groups.map((group) => group.kind)).toEqual([
      "agent",
      "thought",
    ]);
    expect(files.searchFilesPage).toHaveBeenCalledTimes(1);
  });
  it("reveals at most five more thoughts per click and preserves other groups", async () => {
    mocks.thoughts.mockResolvedValue(
      page(
        Array.from({ length: 17 }, (_, i) => ({
          id: `thought-${i}`,
          content: `Thought ${i}`,
          updatedAt: new Date().toISOString(),
          tags: ["tag"],
        })),
      ),
    );
    function View() {
      const picker = useMentionPicker(true, "", "/ws", files);
      return (
        <MentionPicker
          picker={picker}
          query=""
          onChoose={(option) => {
            if (["expand", "collapse", "retry"].includes(option.kind))
              picker.activateControl(
                option as Parameters<typeof picker.activateControl>[0],
              );
          }}
          onKeyDown={() => {}}
          localWorkspaceIcons={{ local: "⚡" }}
        />
      );
    }
    render(<View />);
    await waitFor(() =>
      expect(screen.getAllByText(/^Thought /)).toHaveLength(5),
    );
    expect(screen.getByText("⚡")).toBeInTheDocument();
    for (const count of [10, 15, 17]) {
      fireEvent.click(screen.getByText("展开更多"));
      expect(screen.getAllByText(/^Thought /)).toHaveLength(count);
      expect(screen.getByText("Local Agent")).toBeInTheDocument();
      expect(
        screen.queryByRole("group", { name: "文件" }),
      ).not.toBeInTheDocument();
    }
    expect(screen.queryByText("展开更多")).not.toBeInTheDocument();
    fireEvent.click(screen.getByText("收起"));
    expect(screen.getAllByText(/^Thought /)).toHaveLength(5);
  });
  it("retains rows and the continuation cursor when loading more fails", async () => {
    const items = Array.from({ length: 5 }, (_, i) => ({
      name: `${i}.txt`,
      path: `${i}.txt`,
      type: "file" as const,
    }));
    vi.mocked(files.searchFilesPage)
      .mockResolvedValueOnce(page(items, "next"))
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce(
        page([{ name: "six", path: "six", type: "file" }]),
      );
    const { result } = renderHook(() =>
      useMentionPicker(true, "txt", "/ws", files),
    );
    await waitFor(() => expect(result.current.groups[2].loading).toBe(false));
    act(() =>
      result.current.activateControl({
        kind: "expand",
        key: "file:expand",
        group: "file",
      }),
    );
    await waitFor(() => expect(result.current.groups[2].error).toBe(true));
    expect(result.current.groups[2].visibleCount).toBe(5);
    expect(result.current.groups[2].items).toHaveLength(5);
    act(() =>
      result.current.activateControl({
        kind: "retry",
        key: "file:retry",
        group: "file",
      }),
    );
    await waitFor(() => expect(result.current.groups[2].items).toHaveLength(6));
    expect(files.searchFilesPage).toHaveBeenLastCalledWith({
      query: "txt",
      cursor: "next",
      limit: 200,
    });
    expect(
      result.current
        .options(result.current.groups[2])
        .filter((item) => item.kind === "file"),
    ).toHaveLength(6);
  });

  it("publishes first pages together and keeps every choice hidden until then", async () => {
    let resolve!: (value: typeof discovery) => void;
    mocks.invoke.mockImplementationOnce(
      () =>
        new Promise((r) => {
          resolve = r;
        }),
    );
    const { result } = renderHook(() =>
      useMentionPicker(true, "a", "/ws", files),
    );
    await waitFor(() => expect(result.current.groups[2].loading).toBe(false));
    expect(result.current.loading).toBe(true);
    expect(result.current.allOptions).toEqual([]);
    expect(result.current.selectedKey).toBeUndefined();
    await act(async () => resolve(discovery));
    expect(result.current.loading).toBe(false);
    expect(result.current.selectedKey).toBe("agent:local");
    act(() => result.current.select("file:2.txt"));
    const expand = result.current.allOptions.find(
      (item) => item.kind === "expand",
    )!;
    act(() => {
      if (expand.kind === "expand") result.current.activateControl(expand);
    });
    expect(result.current.selectedKey).toBe("file:2.txt");
    expect(
      result.current.groups.map((group) => group.visibleCount > 5),
    ).toEqual([false, false, true]);
  });

  it.each(["lightning", "companion-star"])("uses one loading view, then renders the remote workspace icon %s", async (icon) => {
    let resolve!: (value: unknown) => void;
    mocks.invoke.mockImplementationOnce(
      () =>
        new Promise((r) => {
          resolve = r;
        }),
    );
    mocks.thoughts.mockResolvedValue(
      page([
        {
          id: "thought",
          content: "Ready thought",
          updatedAt: new Date().toISOString(),
          tags: [],
        },
      ]),
    );
    render(<PickerView query="" />);
    await waitFor(() => expect(mocks.invoke).toHaveBeenCalled());
    expect(screen.getAllByRole("status")).toHaveLength(1);
    expect(screen.queryByText("Ready thought")).not.toBeInTheDocument();
    await act(async () =>
      resolve({
        ...discovery,
        items: [
          {
            ...discovery.items[0],
            selector: "remote",
            name: "Remote Agent",
            isLocal: false,
            icon,
          },
        ],
      }),
    );
    expect(screen.getByText("Ready thought")).toBeInTheDocument();
    expect(
      screen
        .getByText("Remote Agent")
        .closest("button")
        ?.querySelector(`[data-workspace-icon="${icon}"]`),
    ).toBeInTheDocument();
  });

  it.each([undefined, null, "future-icon", "⚡", "constructor"])(
    "falls back to the robot for unsupported remote icon %s",
    async (icon) => {
      mocks.invoke.mockResolvedValue({
        ...discovery,
        items: [
          {
            ...discovery.items[0],
            selector: "remote",
            name: "Remote Agent",
            isLocal: false,
            icon,
          },
        ],
      });
      render(<PickerView query="" />);
      await waitFor(() =>
        expect(
          screen
            .getByText("Remote Agent")
            .closest("button")
            ?.querySelector('[data-workspace-icon="robot"]'),
        ).toBeInTheDocument(),
      );
    },
  );

  it("shows staged local results at two seconds and ignores late cloud completion until retry", async () => {
    vi.useFakeTimers();
    try {
      const context = {
        authGeneration: 2,
        principalId: "account",
        networkId: "network",
      };
      mocks.snapshot = { ...mocks.snapshot, ...context, state: "ready" };
      const local = {
        ...discovery,
        ...context,
        complete: false,
        networkStatus: "ready",
      };
      let resolve!: (value: unknown) => void;
      mocks.invoke.mockResolvedValueOnce(local).mockImplementationOnce(
        () =>
          new Promise((r) => {
            resolve = r;
          }),
      );
      const { result, rerender } = renderHook(() =>
        useMentionPicker(true, "", "/ws", files),
      );
      await act(async () => vi.advanceTimersByTimeAsync(0));
      expect(mocks.invoke).toHaveBeenNthCalledWith(1, "cmd_agent_discovery", {
        localOnly: true,
      });
      expect(mocks.invoke).toHaveBeenNthCalledWith(2, "cmd_agent_discovery", {
        localOnly: false,
      });
      expect(result.current.allOptions).toEqual([]);
      await act(async () => vi.advanceTimersByTimeAsync(1999));
      expect(result.current.loading).toBe(true);
      await act(async () => vi.advanceTimersByTimeAsync(1));
      expect(result.current.loading).toBe(false);
      expect(result.current.groups[0]).toMatchObject({
        partial: true,
        loading: false,
        error: false,
      });
      expect(result.current.allOptions.map((item) => item.key)).toEqual([
        "agent:local",
        "agent:retry",
      ]);
      const remote = {
        ...local,
        complete: true,
        items: [
          ...local.items,
          { ...local.items[0], selector: "remote", name: "Remote" },
        ],
      };
      await act(async () => resolve(remote));
      expect(result.current.groups[0].items).toHaveLength(1);
      mocks.snapshot = { ...mocks.snapshot, revision: 1, state: "connecting" };
      rerender();
      expect(result.current.loading).toBe(false);
      expect(mocks.invoke).toHaveBeenCalledTimes(2);
      mocks.invoke.mockResolvedValueOnce(local).mockResolvedValueOnce(remote);
      await act(async () =>
        result.current.activateControl({
          kind: "retry",
          key: "agent:retry",
          group: "agent",
        }),
      );
      expect(result.current.groups[0].items).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("bounds a stalled local source and rejects its late first page after a retry", async () => {
    vi.useFakeTimers();
    try {
      let resolve!: (value: unknown) => void;
      mocks.thoughts.mockImplementationOnce(
        () =>
          new Promise((r) => {
            resolve = r;
          }),
      );
      const { result } = renderHook(() =>
        useMentionPicker(true, "", "/ws", files),
      );
      await act(async () => vi.advanceTimersByTimeAsync(2000));
      expect(result.current.loading).toBe(false);
      expect(result.current.groups[1]).toMatchObject({
        loading: false,
        error: true,
      });
      mocks.thoughts.mockResolvedValueOnce(
        page([{ id: "new", content: "new", tags: [], updatedAt: "now" }]),
      );
      await act(async () =>
        result.current.activateControl({
          kind: "retry",
          key: "thought:retry",
          group: "thought",
        }),
      );
      await act(async () =>
        resolve(
          page([{ id: "old", content: "old", tags: [], updatedAt: "now" }]),
        ),
      );
      expect(result.current.groups[1].items.map((item) => item.key)).toEqual([
        "thought:new",
      ]);
    } finally {
      vi.useRealTimers();
    }
  });
  it("marks unavailable sources independently and never requests their owners", async () => {
    mocks.thoughtsAvailable = false;
    const unavailableFiles = { ...files, isAvailable: false };
    const { result } = renderHook(() =>
      useMentionPicker(true, "a", "/ws", unavailableFiles),
    );
    await waitFor(() => expect(result.current.groups[0].loading).toBe(false));
    expect(result.current.groups[1].unavailable).toBe(true);
    expect(result.current.groups[2].unavailable).toBe(true);
    expect(result.current.groups[0].items).toHaveLength(1);
    expect(mocks.thoughts).not.toHaveBeenCalled();
    expect(files.searchFilesPage).not.toHaveBeenCalled();
  });
  it("rejects late results from another workspace/query and resets expansion on reopening", async () => {
    let resolve!: (
      value: ReturnType<
        typeof page<{ name: string; path: string; type: "file" }>
      >,
    ) => void;
    vi.mocked(files.searchFilesPage).mockImplementationOnce(
      () =>
        new Promise((r) => {
          resolve = r;
        }),
    );
    const { result, rerender } = renderHook(
      ({ workspace, query, open }) =>
        useMentionPicker(open, query, workspace, files),
      { initialProps: { workspace: "/old", query: "a", open: true } },
    );
    await waitFor(() => expect(files.searchFilesPage).toHaveBeenCalled());
    rerender({ workspace: "/new", query: "new", open: true });
    await waitFor(() => expect(result.current.groups[2].loading).toBe(false));
    await act(async () =>
      resolve(page([{ name: "old", path: "old", type: "file" }])),
    );
    expect(
      result.current.groups[2].items.some((item) => item.key === "file:old"),
    ).toBe(false);
    const expand = result.current.allOptions.find(
      (item) => item.kind === "expand",
    )!;
    act(() => {
      if (expand.kind === "expand") result.current.activateControl(expand);
    });
    rerender({ workspace: "/new", query: "new", open: false });
    rerender({ workspace: "/new", query: "new", open: true });
    await waitFor(() => expect(result.current.groups[2].loading).toBe(false));
    expect(
      result.current.groups.every((group) => group.visibleCount === 5),
    ).toBe(true);
  });
  it("keeps initial empty groups but shows one unified successful search miss", async () => {
    mocks.invoke.mockResolvedValue({ ...discovery, items: [] });
    vi.mocked(files.searchFilesPage).mockResolvedValue(page([]));
    const view = render(<PickerView query="" />);
    await waitFor(() => expect(screen.getAllByRole("group")).toHaveLength(2));
    view.rerender(<PickerView query="missing" />);
    await waitFor(() => expect(screen.queryAllByRole("group")).toHaveLength(0));
    await waitFor(() =>
      expect(screen.getAllByText("没有匹配结果")).toHaveLength(1),
    );
  });
  it("keeps failed and unavailable search groups visible independently", async () => {
    mocks.invoke.mockResolvedValue({ ...discovery, items: [] });
    mocks.thoughtsAvailable = false;
    vi.mocked(files.searchFilesPage).mockRejectedValue(
      new Error("owner offline"),
    );
    render(<PickerView query="missing" />);
    await waitFor(() => expect(screen.getAllByRole("group")).toHaveLength(2));
    expect(screen.getByText("当前场景不可用")).toBeInTheDocument();
    expect(screen.queryByText("没有匹配结果")).not.toBeInTheDocument();
  });
  it("loads subsequent pages and exposes a scan cutoff rather than claiming all results", async () => {
    vi.mocked(files.searchFilesPage)
      .mockResolvedValueOnce(
        page([{ name: "one", path: "one", type: "file" }], "next"),
      )
      .mockResolvedValueOnce({
        ...page([{ name: "two", path: "two", type: "file" }]),
        complete: false,
        scanLimitReached: true,
      });
    const { result } = renderHook(() =>
      useMentionPicker(true, "a", "/ws", files),
    );
    await waitFor(() => expect(result.current.groups[2].loading).toBe(false));
    act(() =>
      result.current.activateControl({
        kind: "expand",
        key: "file:expand",
        group: "file",
      }),
    );
    await waitFor(() => expect(result.current.groups[2].partial).toBe(true));
    expect(result.current.groups[2].items.map((item) => item.key)).toEqual([
      "file:one",
      "file:two",
    ]);
    expect(files.searchFilesPage).toHaveBeenLastCalledWith({
      query: "a",
      cursor: "next",
      limit: 200,
    });
  });
});
