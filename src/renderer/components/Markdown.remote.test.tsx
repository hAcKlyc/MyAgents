import { render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@/utils/browserMock", () => ({ isTauriEnvironment: () => true }));
vi.mock("@/components/FilePreviewModal", () => ({ default: () => null }));
vi.mock("@/context/ImagePreviewContext", () => ({
  useImagePreview: () => ({ openPreview: vi.fn() }),
}));
import Markdown from "./Markdown";
it("remote Markdown displays text without local file links, network images or embedded diagrams", () => {
  render(
    <Markdown workspacePath={null} remoteContent>
      {
        "[file](/Users/local/private.txt)\n\n[web](https://example.invalid/)\n\n![network image](https://example.invalid/tracker.png)\n\n![local image](/Users/local/private.png)\n\n`/Users/local/private.txt`\n\n```mermaid\ngraph LR; A --> B\n```"
      }
    </Markdown>,
  );
  expect(screen.queryByRole("link")).toBeNull();
  expect(screen.queryByRole("img")).toBeNull();
  expect(screen.getByText("network image")).toBeInTheDocument();
  expect(screen.getByText("local image")).toBeInTheDocument();
  expect(invoke).not.toHaveBeenCalled();
});
