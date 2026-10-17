/* Feedback operations share the existing admin session. No credentials or bodies are persisted in browser storage. */
"use strict";
window.FeedbackAdmin = (() => {
  let epoch = 0,
    pending = null;
  const status = { new: "待处理", in_progress: "处理中", resolved: "已解决" };
  const kinds = { bug: "问题反馈", suggestion: "功能建议", help: "使用疑问" };
  const node = (tag, text, cls) => {
    const n = document.createElement(tag);
    if (text !== undefined) n.textContent = text;
    if (cls) n.className = cls;
    return n;
  };
  const time = (value) => new Date(value * 1000).toLocaleString("zh-CN");
  function reset() {
    epoch++;
    pending = null;
  }
  async function render(root, request, active) {
    const current = ++epoch;
    root.append(
      node("p", "查看用户问题、建议和使用疑问，回复并更新处理进度。", "muted"),
    );
    const message = node("p", "正在加载反馈…", "notice");
    message.setAttribute("role", "status");
    root.append(message);
    const cards = node("div", undefined, "provider-list");
    root.append(cards);
    const retry = node("button", "重试原处理请求");
    retry.type = "button";
    retry.hidden = !pending;
    root.append(retry);
    const runPending = async () => {
      if (!pending) return;
      const body = pending.body,
        path = pending.path;
      retry.disabled = true;
      try {
        await request(path, "PATCH", body);
        if (current !== epoch || !active()) return;
        pending = null;
        root.replaceChildren();
        await render(root, request, active);
      } catch (e) {
        if (current !== epoch || !active()) return;
        message.textContent = e.uncertain
          ? "结果尚未确认，保留原请求并重试。"
          : e.code === "REVISION_CONFLICT"
            ? "反馈已被其他管理员更新，请刷新后核对。"
            : e.message;
        if (!e.uncertain) {
          pending = null;
          root
            .querySelectorAll("form button,form select,form textarea")
            .forEach((control) => {
              control.disabled = false;
            });
        }
        retry.hidden = !pending;
      } finally {
        retry.disabled = false;
      }
    };
    retry.addEventListener("click", () => void runPending());
    try {
      const result = await request("/api/admin/feedback");
      if (current !== epoch || !active()) return;
      message.hidden = true;
      if (!result.items.length)
        cards.append(node("p", "暂无用户反馈。", "empty"));
      for (const item of result.items) {
        const card = node("section", undefined, "provider-card");
        card.append(
          node("span", status[item.status], "badge"),
          node("h2", item.title),
          node(
            "small",
            `${kinds[item.category]} · ${time(item.created_at)} · 账号 ${item.principal_id}`,
          ),
          node("p", item.description, "feedback-description"),
        );
        if (item.app_version)
          card.append(node("small", `应用版本 ${item.app_version}`));
        const history = node("details");
        history.append(node("summary", "处理记录"));
        for (const event of item.events || []) {
          const row = node("div", undefined, "audit-event");
          row.append(
            node(
              "small",
              `${time(event.created_at)} · ${event.kind === "created" ? "已提交" : event.kind === "reply" ? "管理员回复" : status[event.status] || "状态更新"}`,
            ),
          );
          if (event.reply)
            row.append(node("p", event.reply, "feedback-description"));
          history.append(row);
        }
        card.append(history);
        const form = node("form");
        const statusLabel = node("label", "处理状态", "field");
        const select = node("select");
        for (const [value, label] of Object.entries(status)) {
          const option = node("option", label);
          option.value = value;
          select.append(option);
        }
        select.value = item.status;
        statusLabel.append(select);
        const replyLabel = node("label", "回复用户", "field");
        const reply = node("textarea");
        reply.rows = 3;
        reply.maxLength = 4000;
        reply.placeholder = "填写处理结果、补充问题或操作建议";
        replyLabel.append(reply);
        const save = node("button", "保存处理结果", "primary");
        save.type = "submit";
        save.disabled = !!pending;
        const error = node("p", undefined, "error");
        error.setAttribute("role", "status");
        form.append(statusLabel, replyLabel, error, save);
        card.append(form);
        cards.append(card);
        form.addEventListener("submit", async (e) => {
          e.preventDefault();
          if (pending || save.disabled) return;
          const text = reply.value.trim();
          if (select.value === item.status && !text) {
            error.textContent = "请更新状态或填写回复。";
            return;
          }
          pending = {
            path: `/api/admin/feedback/${item.id}`,
            body: {
              mutation_id: crypto.randomUUID(),
              expected_revision: item.revision,
              status: select.value,
              reply: text,
            },
          };
          const original = pending;
          save.disabled = true;
          select.disabled = true;
          reply.disabled = true;
          try {
            await request(original.path, "PATCH", original.body);
            if (current !== epoch || !active()) return;
            pending = null;
            root.replaceChildren();
            await render(root, request, active);
          } catch (failure) {
            if (current !== epoch || !active()) return;
            error.textContent = failure.uncertain
              ? "结果尚未确认，回复内容已保留，请重试原请求。"
              : failure.code === "REVISION_CONFLICT"
                ? "反馈已更新，内容已保留。请刷新后核对。"
                : failure.message;
            if (failure.uncertain) {
              retry.hidden = false;
              message.hidden = false;
              message.textContent =
                "有待确认的处理请求，重试时沿用原编号和原内容。";
            } else {
              pending = null;
              save.disabled = false;
              select.disabled = false;
              reply.disabled = false;
            }
          }
        });
      }
    } catch (e) {
      if (current === epoch && active()) {
        message.hidden = false;
        message.textContent = e.message;
      }
    }
  }
  return { render, reset };
})();
