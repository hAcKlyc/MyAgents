import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { expect, it, vi } from "vitest";
import { JoinNetworkDialog } from "./JoinNetworkDialog";
const attempt = {
  attemptId: "attempt-ui",
  authorizationUrl: "https://cloud.test/authorize?state=synthetic-only",
  expiresAt: 1900000000,
};
it("automatically opens the browser and closes after focus detects a completed login", async () => {
  const poll = vi.fn().mockResolvedValue("authenticated");
  const open = vi.fn().mockResolvedValue(undefined);
  const cancel = vi.fn();
  function Harness() {
    const [shown, setShown] = useState(true);
    return shown ? (
      <JoinNetworkDialog
        accountOnly
        initialUrl="https://cloud.test"
        onConfirm={vi.fn()}
        onOwnedStart={async () => attempt}
        onOwnedOpen={open}
        onOwnedPoll={poll}
        onOwnedCancel={cancel}
        onCancel={() => setShown(false)}
      />
    ) : (
      <p>登录完成</p>
    );
  }
  render(<Harness />);
  fireEvent.click(screen.getByRole("button", { name: "在浏览器中继续" }));
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "检查登录状态" })).toBeEnabled(),
  );
  expect(open).toHaveBeenCalledExactlyOnceWith("attempt-ui");
  expect(screen.getByText(attempt.authorizationUrl)).not.toBeVisible();
  fireEvent(window, new Event("focus"));
  expect(await screen.findByText("登录完成")).toBeInTheDocument();
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  expect(cancel).not.toHaveBeenCalled();
});
it("keeps the full authorization link in collapsed advanced information and manual checking available", async () => {
  const poll = vi.fn().mockResolvedValue("pending");
  const open = vi.fn().mockResolvedValue(undefined);
  render(
    <JoinNetworkDialog
      accountOnly
      initialUrl="https://cloud.test"
      onConfirm={vi.fn()}
      onOwnedStart={async () => attempt}
      onOwnedOpen={open}
      onOwnedPoll={poll}
      onOwnedCancel={vi.fn()}
      onCancel={vi.fn()}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "在浏览器中继续" }));
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "检查登录状态" })).toBeEnabled(),
  );
  expect(screen.getByText(attempt.authorizationUrl)).not.toBeVisible();
  fireEvent.click(screen.getByText("高级连接选项"));
  expect(screen.getByText(attempt.authorizationUrl)).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "检查登录状态" }));
  await waitFor(() =>
    expect(poll).toHaveBeenCalledExactlyOnceWith("attempt-ui"),
  );
});
