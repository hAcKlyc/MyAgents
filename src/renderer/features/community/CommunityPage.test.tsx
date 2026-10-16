import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { createInstance } from "i18next";
import { I18nextProvider, initReactI18next } from "react-i18next";
import { beforeEach, describe, expect, it, vi } from "vitest";

import en from "@/i18n/locales/en-US/community.json";
import zh from "@/i18n/locales/zh-CN/community.json";
import CommunityPage from "./CommunityPage";
import {
  communityRequest,
  type CommunityRequest,
  type CommunityScope,
  type CommunityTopic,
} from "./api";

vi.mock("./api", () => ({ communityRequest: vi.fn() }));
const request = vi.mocked(communityRequest);
const scope: CommunityScope = {
  connectionId: "connection-1",
  principalId: "user-1",
  bindingId: "binding-1",
};
const topic: CommunityTopic = {
  id: "topic-1",
  category: "discussion",
  title: "A shared idea",
  content: "<script>plain text</script>",
  author_name: "Member",
  created_at: 1792140000000,
  updated_at: 1792140000000,
  revision: 1,
  reply_count: 0,
  is_owner: true,
  pinned: false,
  locked: false,
  visibility: "visible",
};
const i18n = createInstance();
void i18n.use(initReactI18next).init({
  lng: "en-US",
  resources: { "en-US": { community: en }, "zh-CN": { community: zh } },
  interpolation: { escapeValue: false },
  react: { useSuspense: false },
});

function page(identity = scope) {
  return (
    <I18nextProvider i18n={i18n}>
      <CommunityPage scope={identity} />
    </I18nextProvider>
  );
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}
async function compose(title = "New idea", content = "My work") {
  await screen.findByText("A shared idea");
  fireEvent.click(screen.getByRole("button", { name: "New topic" }));
  fireEvent.change(screen.getByLabelText("Title"), {
    target: { value: title },
  });
  fireEvent.change(screen.getByLabelText("Content"), {
    target: { value: content },
  });
}

beforeEach(() => {
  request.mockReset();
  request.mockImplementation(async (_scope, input) => {
    if (input.kind === "list") return { items: [topic] } as never;
    if (input.kind === "detail") return { topic, replies: [] } as never;
    if (input.kind === "create")
      return { ...topic, title: input.title, content: input.content } as never;
    return {
      id: "reply-1",
      content: input.content,
      author_name: "Member",
      created_at: topic.created_at,
    } as never;
  });
});

describe("CommunityPage", () => {
  it("filters topics, opens plain text detail, replies, refreshes, and returns to the list", async () => {
    render(page());
    await screen.findByText(topic.title);
    fireEvent.click(screen.getByRole("button", { name: "Questions" }));
    expect(screen.queryByText(topic.title)).not.toBeInTheDocument();
    expect(screen.getByText(en.empty)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "All" }));
    fireEvent.click(screen.getByText(topic.title));
    expect(await screen.findByText(topic.content)).toBeInTheDocument();
    expect(document.querySelector("script")).toBeNull();
    fireEvent.change(screen.getByLabelText("Your reply"), {
      target: { value: "Useful idea" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Send reply" }));
    await waitFor(() =>
      expect(request).toHaveBeenCalledWith(
        scope,
        expect.objectContaining({
          kind: "reply",
          topicId: topic.id,
          content: "Useful idea",
        }),
      ),
    );
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Refresh" })).toBeEnabled(),
    );
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Refresh" })).toBeEnabled(),
    );
    fireEvent.click(screen.getByRole("button", { name: "Back to topics" }));
    expect(await screen.findByText(topic.title)).toBeInTheDocument();
  });

  it("counts Unicode scalars and enforces title and body limits before sending", async () => {
    render(page());
    await compose("😀".repeat(120), "😀".repeat(8000));
    const publish = screen.getByRole("button", { name: "Publish topic" });
    expect(publish).toBeEnabled();
    fireEvent.change(screen.getByLabelText("Title"), {
      target: { value: "😀".repeat(121) },
    });
    expect(publish).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Title"), {
      target: { value: "😀".repeat(120) },
    });
    fireEvent.change(screen.getByLabelText("Content"), {
      target: { value: "😀".repeat(8001) },
    });
    expect(publish).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Content"), {
      target: { value: "😀".repeat(8000) },
    });
    fireEvent.click(publish);
    await waitFor(() =>
      expect(request).toHaveBeenCalledWith(
        scope,
        expect.objectContaining({
          kind: "create",
          title: "😀".repeat(120),
          content: "😀".repeat(8000),
        }),
      ),
    );
  });

  it.each([
    "OWNED_RESPONSE_INVALID",
    "ACCOUNT_BINDING_CHANGED",
    "OWNED_SESSION_INVALID",
    "NETWORK_FEATURE_DISABLED",
    "NETWORK_CONNECTION_NOT_FOUND",
    "OWNED_SERVICE_UNAVAILABLE",
  ])(
    "retains exact create body/id and locks edits for uncertain %s without automatic writes",
    async (code) => {
      const calls: CommunityRequest[] = [];
      request.mockImplementation(async (_scope, input) => {
        if (input.kind === "list") return { items: [topic] } as never;
        if (input.kind === "create") {
          calls.push(input);
          throw { code, retryable: true };
        }
        return { topic, replies: [] } as never;
      });
      render(page());
      await compose("  My title  ", "  Keep exact content  ");
      fireEvent.click(screen.getByRole("button", { name: "Publish topic" }));
      await screen.findByText(en.writeUncertain);
      expect(calls).toHaveLength(1);
      expect(screen.getByLabelText("Title")).toBeDisabled();
      expect(screen.getByLabelText("Content")).toBeDisabled();
      expect(
        screen.getByRole("button", { name: "Back to topics" }),
      ).toBeDisabled();
      fireEvent.click(
        screen.getByRole("button", { name: "Retry this submission" }),
      );
      await waitFor(() => expect(calls).toHaveLength(2));
      expect(calls[1]).toBe(calls[0]);
      expect(calls[1]).toMatchObject({
        title: "  My title  ",
        content: "  Keep exact content  ",
      });
    },
  );

  it("keeps an uncertain reply fixed and retries it once without duplicating an in-flight write", async () => {
    const pending = deferred<never>();
    render(page());
    fireEvent.click(await screen.findByText(topic.title));
    const input = await screen.findByLabelText("Your reply");
    fireEvent.change(input, { target: { value: "  Exact reply  " } });
    request.mockReturnValueOnce(pending.promise);
    const send = screen.getByRole("button", { name: "Send reply" });
    fireEvent.click(send);
    fireEvent.click(send);
    const writes = () =>
      request.mock.calls.filter(([, value]) => value.kind === "reply");
    expect(writes()).toHaveLength(1);
    await act(async () =>
      pending.reject({ code: "OWNED_ACCOUNT_UNAVAILABLE", retryable: true }),
    );
    await screen.findByText(en.writeUncertain);
    expect(input).toBeDisabled();
    fireEvent.click(
      screen.getByRole("button", { name: "Retry this submission" }),
    );
    await waitFor(() => expect(writes()).toHaveLength(2));
    expect(writes()[1][1]).toBe(writes()[0][1]);
    expect(writes()[1][1]).toMatchObject({
      topicId: topic.id,
      content: "  Exact reply  ",
    });
    await waitFor(() =>
      expect(screen.getByLabelText("Your reply")).toHaveValue(""),
    );
  });

  it("unlocks a preserved draft after definitive rejection", async () => {
    request.mockImplementation(async (_scope, input) => {
      if (input.kind === "list") return { items: [topic] } as never;
      throw { code: "REQUEST_INVALID", retryable: false };
    });
    render(page());
    await compose();
    fireEvent.click(screen.getByRole("button", { name: "Publish topic" }));
    await screen.findByText(en.writeFailed);
    expect(screen.getByLabelText("Title")).toBeEnabled();
    expect(screen.getByLabelText("Title")).toHaveValue("New idea");
  });

  it("keeps locked topics read-only and enforces Unicode reply limits", async () => {
    render(page());
    fireEvent.click(await screen.findByText(topic.title));
    const input = await screen.findByLabelText("Your reply");
    fireEvent.change(input, { target: { value: "😀".repeat(4000) } });
    expect(screen.getByRole("button", { name: "Send reply" })).toBeEnabled();
    fireEvent.change(input, { target: { value: "😀".repeat(4001) } });
    expect(screen.getByRole("button", { name: "Send reply" })).toBeDisabled();
    request.mockResolvedValueOnce({
      topic: { ...topic, locked: true },
      replies: [],
    });
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    await screen.findByText(en.locked);
    expect(screen.queryByLabelText("Your reply")).not.toBeInTheDocument();
  });

  it("discards old reads and drafts on account or credential-binding switches", async () => {
    const old = deferred<{ items: CommunityTopic[] }>();
    request.mockReturnValueOnce(old.promise);
    const rendered = render(page());
    rendered.rerender(
      page({ ...scope, principalId: "user-2", bindingId: "binding-2" }),
    );
    await compose("Private draft", "Private body");
    await act(async () =>
      old.resolve({ items: [{ ...topic, title: "Old private data" }] }),
    );
    expect(screen.queryByText("Old private data")).not.toBeInTheDocument();
    rendered.rerender(
      page({ ...scope, principalId: "user-2", bindingId: "binding-3" }),
    );
    await screen.findByText(topic.title);
    fireEvent.click(screen.getByRole("button", { name: "New topic" }));
    expect(screen.getByLabelText("Title")).toHaveValue("");
    expect(screen.getByLabelText("Content")).toHaveValue("");
  });

  it("ignores detail completions after navigating back or unmounting", async () => {
    const pending = deferred<{ topic: CommunityTopic; replies: [] }>();
    const rendered = render(page());
    await screen.findByText(topic.title);
    request.mockReturnValueOnce(pending.promise);
    fireEvent.click(screen.getByText(topic.title));
    fireEvent.click(screen.getByRole("button", { name: "Back to topics" }));
    await screen.findByText(topic.title);
    await act(async () =>
      pending.resolve({
        topic: { ...topic, content: "Late private detail" },
        replies: [],
      }),
    );
    expect(screen.queryByText("Late private detail")).not.toBeInTheDocument();
    const late = deferred<{ items: CommunityTopic[] }>();
    request.mockReturnValueOnce(late.promise);
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    rendered.unmount();
    await act(async () => late.resolve({ items: [] }));
    expect(screen.queryByText(en.empty)).not.toBeInTheDocument();
  });

  it("does not apply an old account write completion after switching identities", async () => {
    const pending = deferred<CommunityTopic>();
    const rendered = render(page());
    await compose();
    request.mockReturnValueOnce(pending.promise);
    fireEvent.click(screen.getByRole("button", { name: "Publish topic" }));
    rendered.rerender(page({ ...scope, principalId: "other" }));
    await screen.findByText(topic.title);
    await act(async () =>
      pending.resolve({ ...topic, title: "Private write result" }),
    );
    expect(screen.queryByText("Private write result")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "New topic" })).toBeEnabled();
  });

  it("offers explicit recovery for a read failure and has matching locale keys", async () => {
    request.mockRejectedValueOnce(new Error("offline"));
    render(page());
    await screen.findByText(en.readFailed);
    fireEvent.click(screen.getByRole("button", { name: "Try loading again" }));
    await screen.findByText(topic.title);
    expect(Object.keys(zh).sort()).toEqual(Object.keys(en).sort());
    expect(Object.keys(zh.categories).sort()).toEqual(
      Object.keys(en.categories).sort(),
    );
  });
});
