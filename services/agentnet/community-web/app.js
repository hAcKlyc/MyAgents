/* Same-origin account service; bearer is memory-only. Only a short-lived PKCE
 * transaction and a bounded, principal-bound draft may survive login navigation. */
"use strict";
const $ = (id) => document.getElementById(id);
const labels = { discussion: "交流讨论", question: "使用求助", showcase: "实践分享", announcement: "社区公告" };
const errors = {
  REQUEST_INVALID: "请检查分类、标题和内容长度。", REQUEST_TOO_LARGE: "内容过长，请缩短后重试。",
  COMMUNITY_NOT_FOUND: "话题不存在或当前不可见。", COMMUNITY_LOCKED: "该话题已锁定，暂时不能回复。",
  ADMIN_REQUIRED: "此操作需要管理员权限。", REVISION_CONFLICT: "话题已更新，请刷新后重试。",
  MUTATION_CONFLICT: "原操作编号与请求不一致，请保留内容并联系管理员。",
  UNAUTHORIZED: "登录已失效，请重新登录。", COMMUNITY_UNAVAILABLE: "社区服务暂不可用，请稍后重试。",
};
const loginKey = "moxbots.community.pending-login.v1";
let token = null, principalId = null, activeLogin = null, loginEpoch = 0, listEpoch = 0, detailEpoch = 0;
let items = [], filter = "all", currentTopic = null, requestedTopic = null, pending = null, sending = false, detailInvoker = null;
let replyDraft = { topicId: null, content: "" };
const node = (tag, text, cls) => { const n = document.createElement(tag); if (text !== undefined) n.textContent = text; if (cls) n.className = cls; return n; };
const time = (value) => new Date(value).toLocaleString("zh-CN", { year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
const base64url = (bytes) => btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
function notice(text, error = false) { $("notice").textContent = text; $("notice").className = error ? "notice error" : "notice"; $("notice").hidden = !text; }
function forgetContext() { try { sessionStorage.removeItem(loginKey); } catch { /* unavailable storage */ } }
function saveReplyDraft() { if (currentTopic) replyDraft = { topicId: currentTopic.id, content: $("reply-form").elements.content.value }; }
function forgetSession(message = "") {
  saveReplyDraft(); token = null; loginEpoch++; listEpoch++; detailEpoch++; activeLogin = null; forgetContext();
  items = []; currentTopic = null; sending = false;
  $("workspace").hidden = true; $("login").hidden = false; $("logout").hidden = true;
  $("login-button").disabled = false; $("cancel-login").hidden = true; $("login-status").textContent = message;
  $("create-dialog").close(); $("detail-dialog").close(); $("list").replaceChildren(); $("detail-body").replaceChildren();
  lockForms();
}
async function request(path, method = "GET", body, auth = true) {
  const captured = token, controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  try {
    const response = await fetch(path, { method, credentials: "omit", cache: "no-store", signal: controller.signal,
      headers: { ...(auth && captured ? { Authorization: `Bearer ${captured}` } : {}), ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    let value;
    try { value = await response.json(); } catch { const e = new Error("服务响应异常，请稍后重试。"); e.status = response.status; e.uncertain = method !== "GET"; throw e; }
    if (auth && captured !== token) { const e = new Error("账号已变化，请重新查看。"); e.status = 409; throw e; }
    if (!response.ok || value.ok === false) {
      const code = value.error?.code || value.code || `HTTP_${response.status}`;
      const e = new Error(errors[code] || "请求失败，请稍后重试。"); e.code = code; e.status = response.status;
      e.uncertain = method !== "GET" && response.status >= 500;
      if (auth && response.status === 401) forgetSession(e.message);
      throw e;
    }
    return value.ok === true ? value.data : value;
  } catch (e) { if (!e.status) e.uncertain = method !== "GET"; throw e; } finally { clearTimeout(timeout); }
}
function topicValues() { return Object.fromEntries(new FormData($("topic-form"))); }
function boundedValues(values) { return values && ["discussion", "question", "showcase"].includes(values.category) && typeof values.title === "string" && [...values.title].length <= 120 && typeof values.content === "string" && [...values.content].length <= 8000; }
function draftContext() {
  // Disabled fields are omitted by FormData; read controls directly for an uncertain request.
  const form = $("topic-form");
  const values = { category: form.elements.category.value, title: form.elements.title.value, content: form.elements.content.value };
  saveReplyDraft();
  return principalId && boundedValues(values) ? { principalId, values, reply: { ...replyDraft }, pending } : null;
}
async function cancelLogin() {
  const old = activeLogin; activeLogin = null; loginEpoch++; forgetContext();
  $("login-button").disabled = false; $("cancel-login").hidden = true; $("login-status").textContent = "登录已取消，可重新登录。";
  if (old) try { await request("/auth/login/cancel", "DELETE", { transactionId: old.tx.transactionId, deviceId: old.deviceId, pkceVerifier: old.verifier }, false); } catch { /* Transaction TTL also bounds cancellation. */ }
}
async function login() {
  const epoch = ++loginEpoch; $("login-button").disabled = true; $("login-status").textContent = "正在前往账号登录…";
  try {
    const deviceId = crypto.randomUUID(), verifier = base64url(crypto.getRandomValues(new Uint8Array(32)));
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
    const tx = await request("/auth/login/start", "POST", { deviceId, pkceChallenge: base64url(new Uint8Array(digest)), browserReturn: true, browserReturnPath: "/community" }, false);
    if (epoch !== loginEpoch) return;
    activeLogin = { tx, deviceId, verifier, draft: draftContext() };
    const url = new URL(tx.authorizationUrl);
    if (url.username || url.password || (url.protocol !== "https:" && url.origin !== location.origin)) throw new Error("账号登录地址无效，请联系管理员。");
    sessionStorage.setItem(loginKey, JSON.stringify(activeLogin)); location.assign(url.href);
  } catch (e) { if (epoch === loginEpoch) { await cancelLogin(); $("login-status").textContent = e.message; } }
}
function restoreDraft(draft) {
  $("topic-form").reset(); $("reply-form").reset(); replyDraft = { topicId: null, content: "" }; pending = null;
  if (!principalId || draft?.principalId !== principalId || !boundedValues(draft.values)) return;
  for (const [name, value] of Object.entries(draft.values)) if (["category", "title", "content"].includes(name)) $("topic-form").elements.namedItem(name).value = value;
  if (typeof draft.reply?.topicId === "string" && /^[0-9a-f-]{36}$/i.test(draft.reply.topicId) && typeof draft.reply.content === "string" && [...draft.reply.content].length <= 4000) replyDraft = draft.reply;
  const p = draft.pending;
  if (p && /^[0-9a-f-]{36}$/i.test(p.body?.mutation_id || "")) {
    if (p.kind === "topic" && p.path === "/api/community" && ["category", "title", "content"].every((key) => p.body[key] === draft.values[key])) pending = p;
    if (p.kind === "reply" && p.topicId === replyDraft.topicId && p.path === `/api/community/${replyDraft.topicId}/replies` && p.body.content === replyDraft.content) pending = p;
  }
  $("topic-status").textContent = "已恢复本账号草稿，请检查后手动发布。";
  notice(pending ? "已恢复结果待确认的原请求。请打开相应话题或发起话题窗口，重试原请求。" : "已恢复本账号草稿，请检查后发布。");
}
async function resumeLogin() {
  const outcome = new URLSearchParams(location.search).get("login"); if (outcome) history.replaceState(null, "", "/community");
  let context;
  try { const raw = sessionStorage.getItem(loginKey); if (raw && raw.length <= 100000) context = JSON.parse(raw); else if (raw) forgetContext(); } catch { forgetContext(); }
  if (!context) { if (outcome) $("login-status").textContent = "登录请求已失效，请重新登录。"; return; }
  const { tx, deviceId, verifier } = context;
  if (!tx || typeof tx.transactionId !== "string" || typeof deviceId !== "string" || typeof verifier !== "string" || verifier.length < 43 || verifier.length > 128 || !Number.isSafeInteger(tx.expiresAt) || tx.expiresAt <= Date.now() / 1000) {
    forgetContext(); $("login-status").textContent = "登录已过期，请重新登录。"; return;
  }
  activeLogin = context; if (outcome !== "complete") { await cancelLogin(); return; }
  const epoch = ++loginEpoch; $("login-button").disabled = true; $("cancel-login").hidden = false; $("login-status").textContent = "正在完成登录…";
  try {
    for (let i = 0; i < 5 && epoch === loginEpoch; i++) {
      const result = await request("/auth/login/poll", "POST", { transactionId: tx.transactionId, deviceId, pkceVerifier: verifier }, false);
      if (epoch !== loginEpoch) return;
      if (result.accessToken) {
        token = result.accessToken; principalId = result.principalId || null; restoreDraft(context.draft); activeLogin = null; forgetContext();
        $("workspace").hidden = false; $("login").hidden = true; $("logout").hidden = false; $("cancel-login").hidden = true;
        lockForms(); await refresh(); return;
      }
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    throw new Error("登录未完成，请重新登录。");
  } catch (e) { if (epoch === loginEpoch) { await cancelLogin(); forgetSession(e.message); } }
}
function badges(item) {
  const row = node("div", undefined, "badges"); row.append(node("span", labels[item.category] || "交流讨论", `badge ${item.category}`));
  if (item.pinned) row.append(node("span", "置顶", "badge pinned")); if (item.locked) row.append(node("span", "已锁定", "badge locked"));
  if (item.is_owner) row.append(node("span", "我的话题", "badge")); return row;
}
function renderList() {
  const query = $("search").value.trim().toLocaleLowerCase();
  const visible = items.filter((item) => (filter === "all" || item.category === filter) && (!query || [item.title, item.content, item.author_name].some((v) => String(v || "").toLocaleLowerCase().includes(query))))
    .sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.updated_at - a.updated_at);
  $("topic-count").textContent = `${visible.length} 个话题`;
  const list = $("list"); list.replaceChildren();
  if (!visible.length) {
    const empty = node("div", undefined, "empty-state"); empty.append(node("h3", items.length ? "没有找到相关话题" : "第一段交流，从你开始"), node("p", items.length ? "试试其他关键词或分类。" : "分享一个想法，或提出一个你正在探索的问题。")); list.append(empty);
  }
  for (const item of visible) {
    const card = node("button", undefined, "topic-card"); card.type = "button";
    const meta = node("div", undefined, "topic-meta"); meta.append(node("span", `${item.author_name || "社区成员"} · ${time(item.created_at)}`), node("span", `${item.reply_count || 0} 条回复`));
    card.append(badges(item), node("h3", item.title), node("p", item.content, "topic-excerpt"), meta); card.addEventListener("click", () => void openDetail(item.id)); list.append(card);
  }
}
async function refresh() {
  const epoch = ++listEpoch; $("refresh").disabled = true; $("list-status").textContent = "正在加载社区话题…"; $("retry-list").hidden = true;
  try {
    const result = await request("/api/community"); if (epoch !== listEpoch || !token) return;
    items = result.items; $("list-status").textContent = ""; renderList();
  } catch (e) { if (epoch === listEpoch && token) { $("list-status").textContent = `${e.message}${items.length ? " 当前为上次加载的话题。" : ""}`; $("retry-list").hidden = false; } }
  finally { if (epoch === listEpoch) $("refresh").disabled = false; }
}
async function openDetail(id) {
  if (sending) { notice("正在确认发布结果，请稍候。"); return; }
  if (pending?.kind === "reply" && pending.topicId !== id) { notice("上一条回复结果尚未确认，先回到原话题重试原请求。", true); id = pending.topicId; }
  saveReplyDraft(); const epoch = ++detailEpoch; requestedTopic = id; currentTopic = null;
  $("detail-title").textContent = "正在加载话题…"; $("detail-status").textContent = "正在加载详情…"; $("retry-detail").hidden = true; $("detail-body").replaceChildren(); $("reply-section").hidden = true;
  if (!$("detail-dialog").open) { detailInvoker = document.activeElement; $("detail-dialog").showModal(); }
  try {
    const result = await request(`/api/community/${encodeURIComponent(id)}`); if (epoch !== detailEpoch || !token || !$("detail-dialog").open) return;
    currentTopic = result.topic; const item = result.topic, body = $("detail-body");
    $("detail-title").textContent = item.title; $("detail-status").textContent = item.locked ? "管理员已锁定此话题，仍可查看已有讨论。" : "";
    body.append(badges(item), node("p", `${item.author_name || "社区成员"} · ${time(item.created_at)}`, "detail-meta"), node("p", item.content, "body-text topic-content"), node("h3", `讨论 · ${item.reply_count} 条回复`, "reply-heading"));
    if (item.reply_count > result.replies.length) body.append(node("p", `仅展示最新 ${result.replies.length} 条回复。`, "hint"));
    if (!result.replies.length) body.append(node("p", "还没有回复，分享你的第一个想法吧。", "reply-empty"));
    for (const reply of result.replies) { const row = node("article", undefined, "reply-card"); row.append(node("small", `${reply.author_name || "社区成员"} · ${time(reply.created_at)}`), node("p", reply.content, "body-text")); body.append(row); }
    $("reply-form").elements.content.value = replyDraft.topicId === id ? replyDraft.content : "";
    $("reply-section").hidden = false; $("reply-status").textContent = pending?.kind === "reply" ? "上次发布结果尚未确认，请用原请求重试。" : item.locked ? "话题已锁定，无法发布新回复。" : "";
    lockForms();
  } catch (e) { if (epoch === detailEpoch && token) { $("detail-title").textContent = "暂时无法查看话题"; $("detail-status").textContent = e.message; $("retry-detail").hidden = false; } }
}
function lockForms() {
  for (const form of [$("topic-form"), $("reply-form")]) for (const field of form.elements) {
    if (field.type === "button") continue;
    const kind = form.id === "topic-form" ? "topic" : "reply";
    field.disabled = sending || (field.type === "submit" ? (!!pending && pending.kind !== kind) || (kind === "reply" && !!currentTopic?.locked && pending?.kind !== "reply") : !!pending || (kind === "reply" && !!currentTopic?.locked));
  }
  $("submit-topic").textContent = pending?.kind === "topic" ? "重试原话题" : "发布话题";
  $("submit-reply").textContent = pending?.kind === "reply" ? "重试原回复" : "发布回复";
}
async function submit(kind, event) {
  event.preventDefault(); if (!token || sending || (pending && pending.kind !== kind)) return;
  if (kind === "reply" && !currentTopic) return;
  const status = $(kind === "topic" ? "topic-status" : "reply-status");
  if (!pending) {
    const values = kind === "topic" ? topicValues() : { content: $("reply-form").elements.content.value };
    if (!values.content.trim() || (kind === "topic" && !values.title.trim())) { status.textContent = "请填写有效的标题和内容。"; return; }
    pending = { kind, ...(kind === "reply" ? { topicId: currentTopic.id } : {}), path: kind === "topic" ? "/api/community" : `/api/community/${currentTopic.id}/replies`, body: { mutation_id: crypto.randomUUID(), ...values } };
  }
  const original = pending, captured = token; saveReplyDraft(); sending = true; lockForms(); status.textContent = "正在发布…";
  try {
    const result = await request(original.path, "POST", original.body); if (captured !== token) return;
    const keepDetailOpen = $(kind === "topic" ? "create-dialog" : "detail-dialog").open;
    pending = null; sending = false;
    if (kind === "topic") { $("topic-form").reset(); $("create-dialog").close(); status.textContent = ""; }
    else { $("reply-form").reset(); replyDraft = { topicId: null, content: "" }; currentTopic = null; }
    notice(kind === "topic" ? "话题已发布，期待新的交流。" : "回复已发布。"); lockForms();
    await refresh(); if (captured === token && keepDetailOpen) await openDetail(kind === "topic" ? result.id : original.topicId);
  } catch (e) {
    if (captured !== token) { if (e.status === 401 && pending === original && !original.unconfirmed) { pending = null; lockForms(); } return; }
    if (e.uncertain) original.unconfirmed = true;
    else pending = null;
    status.textContent = e.uncertain ? "发布结果尚未确认。内容和操作编号已保留，请重试原请求。" : e.message;
    if (e.code === "COMMUNITY_LOCKED" && currentTopic) currentTopic.locked = true;
  } finally { if (captured === token) { sending = false; lockForms(); } }
}
$("topic-form").addEventListener("submit", (e) => void submit("topic", e));
$("reply-form").addEventListener("submit", (e) => void submit("reply", e));
$("new-topic").addEventListener("click", () => { if (pending?.kind === "reply") { notice("请先确认上一条回复的结果。", true); void openDetail(pending.topicId); return; } $("topic-status").textContent = pending ? "上次发布结果尚未确认，请用原请求重试。" : ""; lockForms(); $("create-dialog").showModal(); });
for (const id of ["close-create", "cancel-create"]) $(id).addEventListener("click", () => $("create-dialog").close());
$("close-detail").addEventListener("click", () => $("detail-dialog").close());
$("detail-dialog").addEventListener("close", () => { saveReplyDraft(); detailEpoch++; if (token) (detailInvoker?.isConnected ? detailInvoker : $("new-topic")).focus(); });
$("reply-form").elements.content.addEventListener("input", saveReplyDraft);
$("retry-detail").addEventListener("click", () => { if (requestedTopic) void openDetail(requestedTopic); });
$("categories").querySelectorAll("button").forEach((b) => b.addEventListener("click", () => { filter = b.dataset.category; $("categories").querySelectorAll("button").forEach((x) => x.setAttribute("aria-pressed", String(x === b))); renderList(); }));
$("search").addEventListener("input", renderList);
for (const id of ["refresh", "retry-list"]) $(id).addEventListener("click", () => void refresh());
$("login-button").addEventListener("click", () => void login()); $("cancel-login").addEventListener("click", () => void cancelLogin());
$("logout").addEventListener("click", async () => {
  const old = token; principalId = null; pending = null; forgetSession("已退出账号。"); replyDraft = { topicId: null, content: "" }; $("topic-form").reset(); $("reply-form").reset();
  $("topic-status").textContent = ""; $("reply-status").textContent = ""; $("search").value = ""; notice(""); lockForms();
  const epoch = loginEpoch;
  if (old) { const controller = new AbortController(), timeout = setTimeout(() => controller.abort(), 15000); try { const response = await fetch("/auth/session", { method: "DELETE", credentials: "omit", signal: controller.signal, headers: { Authorization: `Bearer ${old}` } }); if (!response.ok && response.status !== 401) throw new Error("revoke"); } catch { if (epoch === loginEpoch) $("login-status").textContent = "本页面已退出，远端会话撤销未确认。"; } finally { clearTimeout(timeout); } }
});
window.addEventListener("pagehide", () => { activeLogin = null; });
window.addEventListener("pageshow", () => { if (!token && !activeLogin) void resumeLogin(); });
