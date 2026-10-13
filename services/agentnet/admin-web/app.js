/* Same-origin admin client. Credentials and uncertain mutations live in memory only. */
const $ = id => document.getElementById(id);
let token = null;
let data = null;
let page = 'bots';
let recycle = false;
let search = '';
let busy = false;
let editing = null;
let uncertain = null;
let loginAttempt = 0;
const errors = {
  HOST_EXECUTION_NOT_CONNECTED: 'Host 执行适配尚未接入，Bot 未启动。',
  FORBIDDEN: '当前账号没有本实例的平台管理权限。',
  ADMIN_REQUIRED: '当前账号没有本实例的平台管理权限。',
  REQUEST_INVALID: '请检查必填字段、部署权限和额度。',
  INVALID_BOT_NAME: 'Bot 名称去掉首尾空白后应为 1–60 个字符。',
  BOT_STATE_CONFLICT: 'Bot 状态已变化，请刷新目录后核对。',
  'invalid request': '请检查配置字段的类型和必填内容。',
  ADMIN_STORAGE_UNAVAILABLE: '服务端存储暂不可用，请查询原操作后重试。',
  HOST_ASSIGNMENT_FORBIDDEN: '所选用户没有此 Host 和 Runtime 的部署授权。',
  MODEL_ASSIGNMENT_FORBIDDEN: '所选模型引用不在该用户的授权范围内。',
  RESOURCE_ASSIGNMENT_FORBIDDEN: '配置不符合该用户的 Host、模型、Runtime 或额度授权，请核对后重试。',
  BOT_DELETED: '该 Bot 已在回收站，请先核对当前状态。',
  BOT_NOT_FOUND: 'Bot 已不存在，请刷新目录。',
  MUTATION_ID_CONFLICT: '原操作编号与此请求不一致。请查询原操作回执。',
  BOT_NAME_CONFLICT: '已有同名 Bot，请修改名称。',
  NAME_CONFIRMATION_REQUIRED: '确认名称与 Bot 名称不一致。',
  IMPACT_CONFIRMATION_REQUIRED: '请确认归属变化对权限及配置的影响。',
  UNAUTHORIZED: '登录已失效，请重新登录。',
  REVISION_CONFLICT: '配置已被其他操作更新。请关闭草稿并刷新后重新编辑。',
  CONFLICT: '配置版本或名称发生冲突，请刷新后核对。',
  INVALID_REQUEST: '请检查配置字段、部署权限和额度。',
};
function node(tag, text, className) {
  const n = document.createElement(tag);
  if (text !== undefined) n.textContent = text;
  if (className) n.className = className;
  return n;
}
function button(text, action, className) {
  const b = node('button', text, className);
  b.type = 'button';
  b.addEventListener('click', action);
  b.disabled = busy || !!uncertain;
  return b;
}
function notice(text, failure = false) {
  $('notice').textContent = text;
  $('notice').className = failure ? 'notice warning' : 'notice';
  $('notice').hidden = !text;
}
function forgetSession(message = '') {
  token = null;
  data = null;
  editing = null;
  uncertain = null;
  loginAttempt++;
  $('editor').close();
  $('fields').replaceChildren();
  $('content').replaceChildren();
  $('account').textContent = '';
  $('console').hidden = true;
  $('login').hidden = false;
  $('login-status').textContent = message;
  $('login-button').disabled = false;
}
async function request(path, method = 'GET', body, authenticated = true) {
  const requestToken = token;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  try {
    const response = await fetch(path, {
      method, credentials: authenticated ? 'omit' : 'same-origin', cache: 'no-store', signal: controller.signal,
      headers: {
        ...(authenticated && token ? { Authorization: `Bearer ${token}` } : {}),
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const value = await response.json();
    if (authenticated && requestToken !== token) {
      const error = new Error('账号已切换，旧请求结果已丢弃。');
      error.code = 'STALE_SESSION'; error.status = 409;
      throw error;
    }
    if (!response.ok || value.ok === false) {
      const code = value.error?.code || value.code || `HTTP_${response.status}`;
      const error = new Error(errors[code] || value.error?.message || '请求失败，请核对配置后重试。');
      error.code = code;
      error.status = response.status;
      error.uncertain = authenticated && method !== 'GET' && response.status >= 500;
      if (authenticated && (response.status === 401 || (response.status === 403 && code === 'ADMIN_REQUIRED'))) forgetSession(error.message);
      throw error;
    }
    return value.ok === true ? value.data : value;
  } catch (error) {
    if (error.status === undefined) error.uncertain = true;
    throw error;
  } finally { clearTimeout(timeout); }
}
const base64url = bytes => btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
async function login() {
  const attempt = ++loginAttempt;
  $('login-button').disabled = true;
  $('login-status').textContent = '正在打开账号登录…';
  const popup = window.open('about:blank', 'moxbots-account-login', 'popup,width=560,height=720');
  let tx = null;
  let deviceId;
  let verifier;
  try {
    if (!popup) throw new Error('登录窗口被浏览器阻止，请允许此站点打开登录窗口。');
    deviceId = crypto.randomUUID();
    verifier = base64url(crypto.getRandomValues(new Uint8Array(32)));
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
    tx = await request('/auth/login/start', 'POST', { deviceId, pkceChallenge: base64url(new Uint8Array(digest)) }, false);
    if (attempt !== loginAttempt) throw new Error('登录已取消。');
    const url = new URL(tx.authorizationUrl);
    if (url.username || url.password || (url.protocol !== 'https:' && url.origin !== location.origin)) throw new Error('服务端返回的登录地址无效。');
    popup.location.href = url.href;
    $('login-status').textContent = '请在登录窗口完成授权。';
    for (let i = 0; i < 150 && attempt === loginAttempt; i++) {
      const result = await request('/auth/login/poll', 'POST', { transactionId: tx.transactionId, deviceId, pkceVerifier: verifier }, false);
      if (attempt !== loginAttempt) throw new Error('登录已取消。');
      if (result.accessToken) {
        token = result.accessToken;
        popup.close();
        await refresh();
        return;
      }
      if (popup.closed) throw new Error('登录窗口已关闭，请重新登录。');
      await new Promise(resolve => setTimeout(resolve, 2000));
    }
    throw new Error('登录已超时，请重新登录。');
  } catch (error) {
    if (attempt === loginAttempt) forgetSession(error.message);
    if (tx) {
      try { await request('/auth/login/cancel', 'DELETE', { transactionId: tx.transactionId, deviceId, pkceVerifier: verifier }, false); } catch { /* bounded best effort */ }
    }
    if (popup && !popup.closed) popup.close();
  } finally { $('login-button').disabled = false; }
}
async function refresh() {
  try {
    const next = await request('/api/admin/bootstrap');
    if (!token) return;
    data = next;
    $('login').hidden = true;
    $('console').hidden = false;
    $('account').textContent = `已验证平台管理员 · ${data.principal_id}`;
    render();
  } catch (error) {
    if (token) notice(`刷新失败：${error.message}。当前展示的是上次读取结果。`, true);
    throw error;
  }
}
function userName(id) { return data.users.find(u => u.principal_id === id)?.name || id; }
function hostName(id) { return data.hosts.find(h => h.id === id)?.name || id; }
function summary() {
  const root = node('section', undefined, 'summary');
  for (const [value, label] of [[data.bots.filter(b => !b.deleted).length, '纳管 Bots'], [data.users.length, '已注册用户'], [data.hosts.length, '授权 Hosts']]) {
    const m = node('div', undefined, 'metric');
    m.append(node('strong', String(value)), node('small', label)); root.append(m);
  }
  return root;
}
function render() {
  if (!data) return;
  const titles = { bots: 'Bots 管理', users: '用户', hosts: 'Hosts', audit: '操作审计' };
  $('page-title').textContent = titles[page];
  document.querySelectorAll('[data-page]').forEach(b => {
    b.classList.toggle('active', b.dataset.page === page);
    if (b.dataset.page === page) b.setAttribute('aria-current', 'page');
    else b.removeAttribute('aria-current');
  });
  const content = $('content'); content.replaceChildren();
  $('pending').hidden = !uncertain;
  $('pending-id').textContent = uncertain?.body.mutation_id || '';
  if (page === 'bots') renderBots(content);
  if (page === 'users') renderUsers(content);
  if (page === 'hosts') renderHosts(content);
  if (page === 'audit') renderAudit(content);
}
function renderBots(root) {
  root.append(summary());
  const toolbar = node('div', undefined, 'toolbar');
  const title = node('div', undefined, 'toolbar-title');
  title.append(node('h2', recycle ? 'Bot 回收站' : '全部 Bots'), node('p', '管理登记与运行配置，不访问用户私人会话。', 'muted'));
  const options = node('div', undefined, 'toolbar-options');
  const input = node('input'); input.placeholder = '搜索名称或所属用户'; input.setAttribute('aria-label', '搜索 Bots'); input.value = search;
  input.addEventListener('input', () => { search = input.value; renderBotTable(); });
  const create = button('新建 Bot', () => openEditor('create'), 'primary');
  create.disabled ||= !data.users.length || !data.hosts.length;
  options.append(input, create);
  toolbar.append(title, options); root.append(toolbar);
  const tabs = node('div', undefined, 'tabs');
  tabs.append(button('纳管目录', () => { recycle = false; render(); }, recycle ? '' : 'selected'), button('回收站', () => { recycle = true; render(); }, recycle ? 'selected' : ''));
  [...tabs.children].forEach((b, index) => b.setAttribute('aria-pressed', String(recycle === (index === 1))));
  root.append(tabs, node('div', undefined, 'bot-list')); root.lastChild.id = 'bot-list';
  renderBotTable();
}
function renderBotTable() {
  const list = $('bot-list'); if (!list) return;
  list.replaceChildren();
  const bots = data.bots.filter(b => b.deleted === recycle && `${b.name} ${b.owner_id}`.toLowerCase().includes(search.toLowerCase()));
  if (!bots.length) {
    const empty = node('div', undefined, 'empty');
    const explanation = !data.users.length ? '暂无已注册用户。用户需先完成本实例账号登录，再由运营方声明部署授权。' : !data.hosts.length ? '尚未配置纳管 Host。请由运营方在实例私有配置中声明 Host 与用户部署授权，然后重启服务。' : '新建时选择已注册用户与明确授权的 Host，默认关闭共享。';
    empty.append(node('h2', search ? '没有匹配的 Bots' : recycle ? '回收站为空' : '还没有纳管 Bot'), node('p', search ? '调整关键词后重试。' : explanation));
    list.append(empty); return;
  }
  const wrap = node('div', undefined, 'table-wrap');
  wrap.tabIndex = 0;
  wrap.setAttribute('role', 'region');
  wrap.setAttribute('aria-label', 'Bots 列表及管理操作');
  wrap.append(node('p', '左右滑动表格，可查看完整配置与管理操作。', 'table-hint'));
  const table = node('table');
  const head = node('thead'); const tr = node('tr');
  ['Bot', '所属用户 / Host', '登记状态', '配置 / 额度', '管理操作'].forEach(t => tr.append(node('th', t))); head.append(tr); table.append(head);
  const body = node('tbody');
  for (const bot of bots) {
    const row = node('tr');
    const name = node('td'); name.append(node('span', bot.name, 'name'), node('small', bot.description || '未填写说明'));
    const owner = node('td'); owner.append(node('span', '所属用户 / Host', 'row-label'), node('small', userName(bot.owner_id)), node('span', hostName(bot.host_id)));
    const state = node('td'); state.append(node('span', '登记状态', 'row-label'), node('span', bot.deleted ? '已逻辑删除' : '登记草稿 · 未部署', 'badge'), node('small', 'Host 执行未接入 · 共享关闭'));
    const config = node('td'); config.append(node('span', '配置 / 额度', 'row-label'), node('span', bot.configured ? '配置完整' : '待补全', `badge ${bot.configured ? 'blue' : 'orange'}`), node('small', `${bot.runtime} · 日上限 ${bot.daily_tokens.toLocaleString()} Tokens`), node('small', `版本 ${bot.revision}`));
    const actions = node('td'); const controls = node('div', undefined, 'row-actions');
    if (bot.deleted) controls.append(button('恢复', () => openEditor('restore', bot)));
    else controls.append(button('配置', () => openEditor('configure', bot)), button('分配', () => openEditor('assign', bot)), button('启动', () => mutate(`/api/admin/bots/${bot.id}/start`, 'POST', mutation(bot)).catch(() => {})), button('关闭准入', () => openEditor('stop', bot)), button('删除', () => openEditor('delete', bot), 'danger'));
    actions.append(node('span', '管理操作', 'row-label'), controls); row.append(name, owner, state, config, actions); body.append(row);
  }
  table.append(body); wrap.append(table); list.append(wrap);
}
function renderUsers(root) {
  root.append(node('h2', '已注册用户'), node('p', '账号来自本实例登录服务。管理权限不会开放密码、私人会话或连接器。', 'muted'));
  const cards = node('div', undefined, 'cards');
  for (const user of data.users) {
    const card = node('article', undefined, 'panel');
    card.append(node('h3', user.name || '已注册账号'), node('code', user.principal_id), node('p', `${data.bots.filter(b => b.owner_id === user.principal_id && !b.deleted).length} 个纳管 Bot`)); cards.append(card);
  }
  if (!data.users.length) root.append(node('div', '暂无已注册用户。用户完成本实例账号登录后会出现在这里。', 'empty'));
  root.append(cards);
}
function renderHosts(root) {
  root.append(node('h2', '授权 Hosts'), node('p', '这里列出运营配置中明确纳管的 Host。配置存在不代表设备在线或执行端已连接。', 'muted'));
  const cards = node('div', undefined, 'cards');
  for (const host of data.hosts) {
    const card = node('article', undefined, 'panel');
    card.append(node('h3', host.name), node('code', host.id), node('p', '执行端未接入', 'badge orange'), node('p', `Runtime：${host.runtimes.join(' / ')}`), node('small', `已声明部署权：${host.owner_ids.length} 个用户`)); cards.append(card);
  }
  if (!data.hosts.length) root.append(node('div', '尚未配置纳管 Host。请由运营方声明用户部署授权。', 'empty'));
  root.append(cards);
}
function renderAudit(root) {
  root.append(node('h2', '操作审计'), node('p', '仅展示管理操作元数据，不记录提示词、凭据或私人会话正文。', 'muted'));
  const panel = node('div', undefined, 'panel');
  for (const event of data.audit) {
    const item = node('div', undefined, 'audit-event');
    const at = event.created_at ? new Date(event.created_at * 1000).toLocaleString() : '';
    item.append(node('strong', `${event.action} · ${event.result || '已记录'}`), node('small', `Bot ${event.bot_id || '—'} · 操作者 ${event.actor || event.actor_id || event.principal_id || '—'}`), node('small', `操作 ${event.mutation_id || event.metadata?.mutation_id || '—'} · ${at}`)); panel.append(item);
  }
  if (!data.audit.length) panel.append(node('p', '暂无管理操作记录。', 'muted'));
  root.append(panel);
}
function field(label, name, type, value, hint) {
  const wrapper = node('label', undefined, 'field'); wrapper.append(node('span', label));
  const input = node(type === 'textarea' ? 'textarea' : 'input'); input.name = name;
  if (type !== 'textarea') input.type = type || 'text';
  input.value = value ?? ''; wrapper.append(input);
  if (hint) wrapper.append(node('small', hint)); $('fields').append(wrapper); return input;
}
function select(label, name, items, value) {
  const wrapper = node('label', undefined, 'field'); wrapper.append(node('span', label));
  const input = node('select'); input.name = name;
  for (const [id, text] of items) { const option = node('option', text); option.value = id; input.append(option); }
  input.value = value || ''; wrapper.append(input); $('fields').append(wrapper); return input;
}
function openEditor(kind, bot) {
  if (busy || uncertain) return;
  editing = { kind, bot, revision: bot?.revision || 0 };
  $('fields').replaceChildren(); $('form-error').textContent = '';
  const titles = { create: '新建 Bot', configure: '配置 Bot', assign: '分配所属用户与 Host', delete: '删除 Bot', restore: '恢复 Bot', stop: '关闭 Bot 准入' };
  $('edit-title').textContent = titles[kind];
  $('edit-description').textContent = kind === 'create' ? '创建管理登记，默认未部署、共享关闭。Host 执行接入后才能启动。' : bot.name;
  $('save-editor').textContent = { delete: '确认删除', restore: '确认恢复', stop: '关闭准入', assign: '确认分配' }[kind] || '保存配置';
  $('save-editor').className = kind === 'delete' ? 'danger' : 'primary';
  if (kind === 'delete') field('输入完整 Bot 名称确认', 'confirm_name', 'text', '', '逻辑删除撤销路由与授权，保留审计；不会删除 Host 或私人数据。');
  if (kind === 'restore') $('fields').append(node('p', '恢复后仍为未部署状态，共享关闭，旧权限不恢复。'));
  if (kind === 'stop') $('fields').append(node('p', '关闭新的调用准入。这不表示 Host 上的进程已经停止；当前执行端尚未接入。'));
  let owner;
  let host;
  let runtime;
  let model;
  if (kind === 'create' || kind === 'assign') {
    owner = select('所属用户', 'owner_id', [['', '请选择已注册用户'], ...data.users.map(u => [u.principal_id, u.name || u.principal_id])], bot?.owner_id);
    host = select('运行 Host', 'host_id', [['', '先选择所属用户']], bot?.host_id);
  }
  if (kind === 'create' || kind === 'configure') {
    const name = field('Bot 名称', 'name', 'text', bot?.name); name.maxLength = 60;
    field('说明', 'description', 'textarea', bot?.description);
    runtime = select('Runtime', 'runtime', [['builtin', 'Builtin'], ['codex', 'Codex']], bot?.runtime || 'builtin');
    model = select('模型配置引用', 'model_ref', [['', '待配置（保存停止草稿）']], bot?.model_ref);
    field('系统指令', 'system_prompt', 'textarea', bot?.system_prompt, '可留空保存停止草稿，启动前必须补全。不要填写原始密钥。');
    const budget = field('每日 Token 上限', 'daily_tokens', 'number', bot?.daily_tokens ?? '', `不得超过平台批准上限 ${data.capabilities.max_daily_tokens ?? '以服务端政策为准'}。`);
    budget.min = '1'; budget.step = '1';
  }
  const updateOptions = () => {
    const ownerId = owner?.value || bot?.owner_id;
    const selectedRuntime = runtime?.value || bot?.runtime || 'builtin';
    if (host) {
      const previous = host.value || bot?.host_id;
      host.replaceChildren();
      for (const [id, text] of [['', '请选择授权 Host'], ...data.hosts.filter(h => h.owner_ids.includes(ownerId) && h.runtimes.includes(selectedRuntime)).map(h => [h.id, h.name])]) { const o = node('option', text); o.value = id; host.append(o); }
      host.value = [...host.options].some(o => o.value === previous) ? previous : '';
    }
    if (model) {
      const previous = model.value || bot?.model_ref;
      model.replaceChildren();
      for (const [id, text] of [['', '待配置（保存停止草稿）'], ...data.model_refs.filter(m => m.owner_ids.includes(ownerId) && m.runtimes.includes(selectedRuntime)).map(m => [m.id, m.label])]) { const o = node('option', text); o.value = id; model.append(o); }
      model.value = [...model.options].some(o => o.value === previous) ? previous : '';
    }
  };
  owner?.addEventListener('change', updateOptions); runtime?.addEventListener('change', updateOptions); updateOptions();
  if (kind === 'assign') {
    $('fields').append(node('p', `原归属：${userName(bot.owner_id)} / ${hostName(bot.host_id)}`, 'muted'));
    const label = node('label', undefined, 'check-field'); const check = node('input'); check.type = 'checkbox'; check.name = 'confirm_impact';
    label.append(check, node('span', '确认变化后撤销原共享、使旧审批失效，清空模型引用与系统指令，不迁移私人数据。')); $('fields').append(label);
  }
  $('editor').showModal();
}
function mutation(bot) { return { mutation_id: crypto.randomUUID(), expected_revision: bot?.revision || 0 }; }
async function mutate(path, method, body) {
  const operation = { path, method, body };
  const mutationToken = token;
  busy = true;
  $('save-editor').disabled = true; render();
  let confirmed = false;
  try {
    await request(path, method, body);
    confirmed = true;
    uncertain = null;
    $('editor').close();
    notice('操作已由服务端确认。');
    await refresh();
  } catch (error) {
    if (mutationToken !== token || error.code === 'STALE_SESSION') throw error;
    if (error.uncertain && !confirmed && token) {
      uncertain = operation;
      $('editor').close();
    }
    $('form-error').textContent = uncertain ? '结果未确认，保持原操作编号并查询回执。' : error.message;
    if (token) notice(confirmed ? `操作已确认，但列表刷新失败：${error.message}。请刷新。` : uncertain ? '请求中断，操作结果未确认。请查询原操作，避免重复创建。' : error.message, true);
    throw error;
  } finally { busy = false; $('save-editor').disabled = false; render(); }
}
$('edit-form').addEventListener('submit', async event => {
  event.preventDefault();
  if (!editing || busy || uncertain) return;
  const { kind, bot } = editing;
  const form = Object.fromEntries(new FormData(event.target));
  const body = { ...mutation(bot), ...form };
  if (kind === 'create' || kind === 'configure') {
    body.daily_tokens = Number(body.daily_tokens); body.model_ref = body.model_ref || null;
    if (!Number.isSafeInteger(body.daily_tokens) || body.daily_tokens < 1) { $('form-error').textContent = '请输入有效的整数额度。'; return; }
  }
  if (kind === 'assign') body.confirm_impact = !!form.confirm_impact;
  const path = kind === 'create' ? '/api/admin/bots' : kind === 'configure' ? `/api/admin/bots/${bot.id}` : `/api/admin/bots/${bot.id}/${kind}`;
  try { await mutate(path, kind === 'configure' ? 'PATCH' : 'POST', body); } catch { /* shown in form and notice */ }
});
$('check-receipt').addEventListener('click', async () => {
  if (!uncertain || busy) return;
  try {
    await request(`/api/admin/mutations/${uncertain.body.mutation_id}`);
    uncertain = null; $('editor').close(); notice('原操作回执已确认。'); await refresh();
  } catch (error) { if (token) notice(`查询未确认：${error.message}。仍保留原操作编号。`, true); }
});
$('retry-operation').addEventListener('click', async () => {
  if (!uncertain || busy) return;
  const saved = uncertain;
  try { await mutate(saved.path, saved.method, saved.body); } catch { /* keep the exact operation */ }
});
const closeEditor = () => { if (!busy) { $('editor').close(); editing = null; } };
$('close-editor').addEventListener('click', closeEditor); $('cancel-editor').addEventListener('click', closeEditor);
$('editor').addEventListener('cancel', event => { if (busy) event.preventDefault(); });
$('login-button').addEventListener('click', login);
$('refresh').addEventListener('click', () => refresh().catch(() => {}));
$('logout').addEventListener('click', async () => {
  const old = token; forgetSession('已退出。');
  if (old) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);
    const attempt = loginAttempt;
    try {
      const response = await fetch('/auth/session', { method: 'DELETE', credentials: 'omit', signal: controller.signal, headers: { Authorization: `Bearer ${old}` } });
      if (!response.ok && response.status !== 401) throw new Error('revocation unconfirmed');
    } catch {
      if (attempt === loginAttempt) $('login-status').textContent = '本页面已退出，远端会话撤销未确认。';
    } finally { clearTimeout(timeout); }
  }
});
document.querySelectorAll('[data-page]').forEach(b => b.addEventListener('click', () => { page = b.dataset.page; render(); }));
