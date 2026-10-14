/* Bearer stays in memory. This tab retains only a pending login and its principal-bound draft. */
"use strict";
const $ = (id) => document.getElementById(id);
let token = null,
  loginEpoch = 0,
  activeLogin = null,
  pendingSubmission = null,
  listEpoch = 0;
let principalId = null,
  unconfirmed = false,
  reauthPending = null;
const loginKey = "moxbots.feedback.pending-login.v1";
const labels = {
  new: "待处理",
  in_progress: "处理中",
  resolved: "已解决",
  bug: "问题反馈",
  suggestion: "功能建议",
  help: "使用疑问",
};
const errors = {
  REQUEST_TOO_LARGE: "反馈内容过长，请缩短后重试。",
  UNAUTHORIZED: "登录已失效，请重新登录。",
  FEEDBACK_NOT_FOUND: "反馈不存在或无权查看。",
  REQUEST_INVALID: "请检查标题、类型和描述。",
  MUTATION_CONFLICT: "操作编号已被占用，请保留内容并刷新后重试。",
  FEEDBACK_STORAGE_UNAVAILABLE: "反馈服务暂不可用，请稍后重试。",
};
function node(tag, text, className) {
  const n = document.createElement(tag);
  if (text !== undefined) n.textContent = text;
  if (className) n.className = className;
  return n;
}
function notice(text, error = false) {
  $("notice").textContent = text;
  $("notice").className = error ? "notice error" : "notice";
  $("notice").hidden = !text;
}
function forgetLoginContext() {
  try {
    sessionStorage.removeItem(loginKey);
  } catch {
    /* Storage or best-effort cancellation may be unavailable. */
  }
}
function forgetSession(message = "") {
  if (unconfirmed && pendingSubmission && principalId)
    reauthPending = { principalId, body: pendingSubmission };
  token = null;
  listEpoch++;
  loginEpoch++;
  pendingSubmission = null;
  lockForm(false);
  $("submit").disabled = false;
  $("submit").textContent = "提交反馈";
  activeLogin = null;
  forgetLoginContext();
  $("workspace").hidden = true;
  $("login").hidden = false;
  $("logout").hidden = true;
  $("login-button").disabled = false;
  $("cancel-login").hidden = true;
  $("login-status").textContent = message;
  $("list").replaceChildren();
  $("detail").close();
  $("detail-body").replaceChildren();
}
async function request(path, method = "GET", body, auth = true) {
  const captured = token;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  try {
    const r = await fetch(path, {
      method,
      credentials: "omit",
      cache: "no-store",
      signal: controller.signal,
      headers: {
        ...(auth && token ? { Authorization: `Bearer ${token}` } : {}),
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const value = await r.json();
    if (auth && captured !== token) {
      const e = new Error("账号已变化，请重新查看。");
      e.status = 409;
      throw e;
    }
    if (!r.ok || value.ok === false) {
      const code = value.error?.code || value.code || `HTTP_${r.status}`;
      const e = new Error(errors[code] || "请求失败，请稍后重试。");
      e.status = r.status;
      e.code = code;
      e.uncertain = method !== "GET" && r.status >= 500;
      if (auth && r.status === 401) forgetSession(e.message);
      throw e;
    }
    return value.ok === true ? value.data : value;
  } catch (e) {
    if (!e.status) e.uncertain = true;
    throw e;
  } finally {
    clearTimeout(timeout);
  }
}
const base64url = (bytes) =>
  btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
async function cancelLogin() {
  const old = activeLogin;
  activeLogin = null;
  loginEpoch++;
  forgetLoginContext();
  $("login-button").disabled = false;
  $("cancel-login").hidden = true;
  $("login-status").textContent = "登录已取消，可重新登录。";
  if (old)
    try {
      await request(
        "/auth/login/cancel",
        "DELETE",
        {
          transactionId: old.tx.transactionId,
          deviceId: old.deviceId,
          pkceVerifier: old.verifier,
        },
        false,
      );
    } catch {
      /* Storage or best-effort cancellation may be unavailable. */
    }
}
async function login() {
  const epoch = ++loginEpoch;
  $("login-button").disabled = true;
  $("login-status").textContent = "正在前往账号登录…";
  try {
    const deviceId = crypto.randomUUID();
    const verifier = base64url(crypto.getRandomValues(new Uint8Array(32)));
    const digest = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(verifier),
    );
    const tx = await request(
      "/auth/login/start",
      "POST",
      {
        deviceId,
        pkceChallenge: base64url(new Uint8Array(digest)),
        browserReturn: true,
        browserReturnPath: "/feedback",
      },
      false,
    );
    // A deliberate re-login may navigate away from a failed submission. Keep
    // its text with the short-lived transaction, restoring only for the same
    // principal. This never stores a bearer or automatically submits a draft.
    const values = Object.fromEntries(new FormData($("feedback-form")));
    const draft =
      principalId && values.description
        ? {
            principalId,
            values,
            pending:
              reauthPending?.principalId === principalId
                ? reauthPending.body
                : null,
          }
        : null;
    const context = { tx, deviceId, verifier, draft };
    if (epoch !== loginEpoch) return;
    const url = new URL(tx.authorizationUrl);
    if (
      url.username ||
      url.password ||
      (url.protocol !== "https:" && url.origin !== location.origin)
    )
      throw new Error("账号登录地址无效，请联系管理员。");
    activeLogin = context;
    sessionStorage.setItem(loginKey, JSON.stringify(context));
    location.assign(url.href);
  } catch (e) {
    await cancelLogin();
    $("login-status").textContent = e.message;
  }
}
async function resumeLogin() {
  const outcome = new URLSearchParams(location.search).get("login");
  if (outcome) history.replaceState(null, "", "/feedback");
  let context;
  try {
    context = JSON.parse(sessionStorage.getItem(loginKey) || "null");
  } catch {
    forgetLoginContext();
  }
  if (!context) {
    if (outcome) $("login-status").textContent = "登录请求已失效，请重新登录。";
    return;
  }
  const { tx, deviceId, verifier } = context;
  if (
    !tx ||
    typeof tx.transactionId !== "string" ||
    typeof deviceId !== "string" ||
    typeof verifier !== "string" ||
    verifier.length < 43 ||
    verifier.length > 128 ||
    !Number.isSafeInteger(tx.expiresAt) ||
    tx.expiresAt <= Date.now() / 1000
  ) {
    forgetLoginContext();
    $("login-status").textContent = "登录已过期，请重新登录。";
    return;
  }
  activeLogin = context;
  if (outcome !== "complete") {
    await cancelLogin();
    return;
  }
  const epoch = ++loginEpoch;
  $("login-button").disabled = true;
  $("cancel-login").hidden = false;
  $("login-status").textContent = "正在完成登录…";
  try {
    for (let i = 0; i < 5 && epoch === loginEpoch; i++) {
      const result = await request(
        "/auth/login/poll",
        "POST",
        { transactionId: tx.transactionId, deviceId, pkceVerifier: verifier },
        false,
      );
      if (epoch !== loginEpoch) return;
      if (result.accessToken) {
        token = result.accessToken;
        principalId = result.principalId || null;
        if (context.draft?.principalId === principalId) {
          for (const [name, max] of [
            ["title", 120],
            ["description", 8000],
            ["app_version", 64],
          ]) {
            const value = context.draft.values?.[name];
            if (typeof value === "string" && [...value].length <= max)
              $("feedback-form").elements.namedItem(name).value = value;
          }
          const category = context.draft.values?.category;
          if (["bug", "suggestion", "help"].includes(category))
            $("feedback-form").elements.namedItem("category").value = category;
          $("submit-status").textContent = "已恢复待提交内容，请检查后提交。";
          const pending = context.draft.pending;
          if (
            pending &&
            /^[0-9a-f-]{36}$/i.test(pending.mutation_id || "") &&
            ["title", "description", "category", "app_version"].every(
              (name) =>
                pending[name] ===
                $("feedback-form").elements.namedItem(name).value,
            )
          ) {
            pendingSubmission = pending;
            unconfirmed = true;
            lockForm(true);
            $("submit").textContent = "重试原反馈";
            $("submit-status").textContent =
              "已恢复结果待确认的原反馈，请用原请求重试。";
          }
        } else {
          $("feedback-form").reset();
          unconfirmed = false;
        }
        reauthPending = null;
        activeLogin = null;
        forgetLoginContext();
        $("cancel-login").hidden = true;
        $("workspace").hidden = false;
        $("login").hidden = true;
        $("logout").hidden = false;
        await refresh();
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    throw new Error("登录未完成，请重新登录。");
  } catch (e) {
    if (epoch === loginEpoch) {
      await cancelLogin();
      forgetSession(e.message);
    }
  }
}
function time(value) {
  return new Date(value * 1000).toLocaleString("zh-CN");
}
function showDetail(item) {
  $("detail-title").textContent = item.title;
  const body = $("detail-body");
  body.replaceChildren(
    node("span", labels[item.status], "badge " + item.status),
    node("p", item.description, "description"),
  );
  for (const event of item.events || []) {
    const row = node("div", undefined, "event");
    row.append(
      node(
        "small",
        `${time(event.created_at)} · ${event.kind === "created" ? "已提交" : event.kind === "reply" ? "管理员回复" : labels[event.status] || "状态更新"}`,
      ),
    );
    if (event.reply) row.append(node("p", event.reply));
    body.append(row);
  }
  if (!$("detail").open) $("detail").showModal();
}
async function refresh() {
  const epoch = ++listEpoch;
  $("refresh").disabled = true;
  try {
    const result = await request("/api/feedback");
    if (epoch !== listEpoch || !token) return;
    const list = $("list");
    list.replaceChildren();
    if (!result.items.length)
      list.append(node("p", "还没有反馈，提交后可在这里查看进展。"));
    for (const item of result.items) {
      const card = node("button", undefined, "feedback-card");
      card.type = "button";
      card.append(
        node("span", labels[item.status], "badge " + item.status),
        node("strong", item.title),
        node("small", `${labels[item.category]} · ${time(item.created_at)}`),
      );
      card.addEventListener("click", async () => {
        try {
          const current = await request(`/api/feedback/${item.id}`);
          if (epoch === listEpoch && token) showDetail(current);
        } catch (e) {
          if (token) notice(e.message, true);
        }
      });
      list.append(card);
    }
  } catch (e) {
    if (token) notice(e.message, true);
  } finally {
    $("refresh").disabled = false;
  }
}
function lockForm(lock) {
  for (const input of $("feedback-form").elements)
    if (input.id !== "submit") input.disabled = lock;
}
$("feedback-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!token || $("submit").disabled) return;
  const body = pendingSubmission || {
    mutation_id: crypto.randomUUID(),
    ...Object.fromEntries(new FormData(event.target)),
  };
  pendingSubmission = body;
  lockForm(true);
  $("submit").disabled = true;
  $("submit-status").textContent = "正在提交…";
  const captured = token;
  try {
    const item = await request("/api/feedback", "POST", body);
    if (captured !== token) return;
    pendingSubmission = null;
    unconfirmed = false;
    lockForm(false);
    $("feedback-form").reset();
    $("submit-status").textContent = "反馈已提交，可在右侧查看处理进展。";
    $("submit").textContent = "提交反馈";
    await refresh();
    showDetail(item);
  } catch (e) {
    if (captured !== token) return;
    if (e.uncertain) {
      unconfirmed = true;
      $("submit-status").textContent =
        "提交结果尚未确认。内容已保留，请用原请求重试。";
      $("submit").textContent = "重试原反馈";
    } else {
      pendingSubmission = null;
      unconfirmed = false;
      lockForm(false);
      $("submit-status").textContent = e.message;
      $("submit").textContent = "提交反馈";
    }
  } finally {
    $("submit").disabled = false;
  }
});
$("login-button").addEventListener("click", () => void login());
$("cancel-login").addEventListener("click", () => void cancelLogin());
$("refresh").addEventListener("click", () => void refresh());
$("close-detail").addEventListener("click", () => $("detail").close());
$("logout").addEventListener("click", async () => {
  const old = token;
  principalId = null;
  unconfirmed = false;
  reauthPending = null;
  forgetSession();
  lockForm(false);
  $("submit").textContent = "提交反馈";
  $("submit-status").textContent = "";
  $("feedback-form").reset();
  if (old) {
    const c = new AbortController();
    const timeout = setTimeout(() => c.abort(), 15000);
    try {
      const r = await fetch("/auth/session", {
        method: "DELETE",
        credentials: "omit",
        signal: c.signal,
        headers: { Authorization: `Bearer ${old}` },
      });
      if (!r.ok && r.status !== 401) throw new Error("revoke");
    } catch {
      $("login-status").textContent = "本页面已退出，远端会话撤销未确认。";
    } finally {
      clearTimeout(timeout);
    }
  }
});
void resumeLogin();
