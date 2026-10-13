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
let activeLogin = null;
let freshnessTimer = null;
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
  HOST_CONTEXT_REJECTED: 'Host 状态或连接上下文已变化，请刷新后再操作。',
  GRANT_CHANGE_REQUIRES_EFFECTIVE_REVOCATION: '旧授权尚未由 Host 确认关闭，请等待 Host 回报。',
  GRANT_NOT_ACTIVE: '授权已撤销或正在撤销，请刷新授权状态。',
  GRANT_GENERATION_CONFLICT: '授权代数已变化，请刷新后重新授权。',
  COMMAND_NOT_PENDING: '原操作已完成或不再等待 Host，请查询原操作回执。',
  EXECUTION_MUTATION_MISMATCH: '该操作编号已绑定其他请求，请查询原回执。',
  HOST_COMMAND_OUTCOME_UNCONFIRMED: 'Host 尚有未确认操作，暂不能完成撤销。',
  HOST_CLOSE_UNCONFIRMED: 'Host 尚未报告已停止且关闭准入。',
  HOST_BINDING_MISMATCH: 'Host 返回的 Bot 绑定与现有记录不一致。',
  GRANT_OWNER_REQUIRED: '只有 Host Owner 可签署或撤销该授权。',
  HOST_EXECUTION_MUTATION_REQUIRED: '该 Bot 已接入 Host 执行，请使用 Host 生命周期操作；变更 Owner 前先完成 Host ACK 撤销。',
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
  activeLogin = null;
  clearLoginLink();
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
function clearLoginLink() {
  const link = $('auth-link');
  link.hidden = true;
  link.removeAttribute('href');
  $('cancel-login').hidden = true;
}
async function cancelLogin() {
  const current = activeLogin;
  if (current) current.cancelled = true;
  loginAttempt++;
  activeLogin = null;
  clearLoginLink();
  $('login-button').disabled = false;
  $('login-status').textContent = '登录已取消。';
  if (current?.popup && !current.popup.closed) current.popup.close();
  if (current?.tx) {
    try {
      await request('/auth/login/cancel', 'DELETE', { transactionId: current.tx.transactionId,
        deviceId: current.deviceId, pkceVerifier: current.verifier }, false);
    } catch { /* bounded best effort */ }
  }
}
async function login() {
  const attempt = ++loginAttempt;
  const loginContext = { attempt, tx: null, deviceId: null, verifier: null, popup: null, cancelled: false };
  activeLogin = loginContext;
  clearLoginLink();
  $('login-button').disabled = true;
  $('login-status').textContent = '正在打开账号登录…';
  let popup = null;
  try { popup = window.open('about:blank', 'moxbots-account-login', 'popup,width=560,height=720'); } catch { /* use the visible link below */ }
  loginContext.popup = popup;
  let tx = null;
  let deviceId;
  let verifier;
  try {
    deviceId = crypto.randomUUID();
    loginContext.deviceId = deviceId;
    verifier = base64url(crypto.getRandomValues(new Uint8Array(32)));
    loginContext.verifier = verifier;
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
    tx = await request('/auth/login/start', 'POST', { deviceId, pkceChallenge: base64url(new Uint8Array(digest)) }, false);
    loginContext.tx = tx;
    if (loginContext.cancelled) {
      try { await request('/auth/login/cancel', 'DELETE', { transactionId: tx.transactionId, deviceId, pkceVerifier: verifier }, false); } catch { /* bounded best effort */ }
      tx = null;
    }
    if (attempt !== loginAttempt) throw new Error('登录已取消。');
    const url = new URL(tx.authorizationUrl);
    if (url.username || url.password || (url.protocol !== 'https:' && url.origin !== location.origin)) throw new Error('服务端返回的登录地址无效。');
    const link = $('auth-link');
    link.href = url.href;
    link.hidden = false;
    $('cancel-login').hidden = false;
    if (popup) {
      try { popup.location.href = url.href; } catch { /* separate tab link remains available */ }
    }
    $('login-status').textContent = popup ? '请在登录窗口完成授权；若窗口未显示，可使用下方独立标签页链接。' : '请使用下方独立标签页链接完成授权。';
    for (let i = 0; i < 150 && attempt === loginAttempt; i++) {
      const result = await request('/auth/login/poll', 'POST', { transactionId: tx.transactionId, deviceId, pkceVerifier: verifier }, false);
      if (attempt !== loginAttempt) throw new Error('登录已取消。');
      if (result.accessToken) {
        token = result.accessToken;
        activeLogin = null;
        clearLoginLink();
        if (popup && !popup.closed) popup.close();
        tx = null;
        await refresh();
        return;
      }
      await new Promise(resolve => setTimeout(resolve, 2000));
    }
    throw new Error('登录已超时，请重新登录。');
  } catch (error) {
    if (attempt === loginAttempt) forgetSession(error.message);
    if (tx && !loginContext.cancelled) {
      try { await request('/auth/login/cancel', 'DELETE', { transactionId: tx.transactionId, deviceId, pkceVerifier: verifier }, false); } catch { /* bounded best effort */ }
    }
    if (popup && !popup.closed) popup.close();
  } finally {
    if (attempt === loginAttempt) {
      activeLogin = null;
      clearLoginLink();
      $('login-button').disabled = false;
    }
  }
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
function executionRecord(bot) { return data.execution?.records?.find(item => item.grant?.bot_id === bot.id && item.grant.scope?.host_device_id === bot.host_id) || null; }
function executionHost(bot, record = executionRecord(bot)) {
  const id = record?.grant?.scope?.host_device_id || bot.host_id;
  return data.execution?.hosts?.find(item => item.host_id === id) || null;
}
function observationFresh(host) { const age = host ? Math.floor(Date.now() / 1000) - host.seen_at : Infinity; return Number.isSafeInteger(host?.seen_at) && age >= 0 && age <= 30; }
function observedSnapshot(bot, host) {
  if (!observationFresh(host)) return null;
  return host.observation?.snapshots?.find(item => item.bot_id === bot.id) || null;
}
function canOwnerAct(bot, host) {
  return !!host && bot.owner_id === data.principal_id && host.scope?.host_owner_id === data.principal_id && host.scope?.host_device_id === bot.host_id;
}
function canIssueGrant(bot, host) {
  const o = host?.observation;
  const configuredHost=data.hosts.find(item=>item.id===bot.host_id);
  const runtimes=o?.supported_runtimes?.filter(runtime=>configuredHost?.runtimes?.includes(runtime)) || [];
  return !!data.execution?.enabled && canOwnerAct(bot, host) && observationFresh(host) &&
    o?.allowed_bot_ids?.includes(bot.id) && Array.isArray(o.root_ids) && o.root_ids.length > 0 && runtimes.length > 0 &&
    Number.isSafeInteger(o.policy_expires_at) && o.policy_expires_at > Math.floor(Date.now() / 1000);
}
function latestHostState(bot, host, record) {
  if (!observationFresh(host)) return 'Host 状态未知（报告缺失或超过 30 秒）';
  const snapshot = observedSnapshot(bot, host, record);
  if (!snapshot) return '最新 Host 报告未包含此 Bot；历史回执不代表当前状态';
  if (snapshot.activity === 'running') return `Host Session 已启动 · ${snapshot.admission === 'open' ? '准入开放' : '准入关闭'} · 模型调用未开放`;
  if (snapshot.activity === 'unknown') return 'Host 运行结果未知，准入已关闭；等待核对或原操作回执';
  return `Host ${snapshot.activity === 'stopped' ? 'Session 已停止' : 'Session 未启动'} · ${snapshot.admission === 'open' ? '准入开放' : '准入关闭'}`;
}
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
  $('retry-operation').hidden = !!uncertain?.queued;
  $('check-receipt').hidden = !!uncertain?.path?.endsWith('/grants/revoke');
  $('pending-help').textContent = uncertain?.queued ? 'Host 尚未回传原操作结果。查询原 mutation_id；不要生成新编号。' : uncertain?.path?.endsWith('/grants/revoke') ? '撤销请求结果未知。使用同一 mutation_id 重试，随后等待 Host ACK。' : '保持原操作编号，查询回执或按完全相同的原请求重试。';
  if (page === 'bots') renderBots(content);
  if (page === 'users') renderUsers(content);
  if (page === 'hosts') renderHosts(content);
  if (page === 'audit') renderAudit(content);
  scheduleFreshnessRefresh();
}
function scheduleFreshnessRefresh() {
  clearTimeout(freshnessTimer);
  if (!data?.execution?.hosts?.length) return;
  const now = Math.floor(Date.now()/1000);
  const future = data.execution.hosts.map(host=>host.seen_at+31).filter(at=>at>now).sort((a,b)=>a-b)[0];
  if (future) freshnessTimer=setTimeout(()=>{ if(data && !busy) render(); else scheduleFreshnessRefresh(); },Math.max(1000,(future-now)*1000));
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
    const record = executionRecord(bot); const hostReport = executionHost(bot, record);
    const hostState = latestHostState(bot, hostReport, record);
    const state = node('td'); state.append(node('span', '登记 / Host 状态', 'row-label'), node('span', bot.deleted ? '登记目录已删除' : '已登记', 'badge'), node('small', hostState));
    const config = node('td'); config.append(node('span', '配置 / 额度', 'row-label'), node('span', bot.configured ? '配置完整' : '待补全', `badge ${bot.configured ? 'blue' : 'orange'}`), node('small', `${bot.runtime} · 日上限 ${bot.daily_tokens.toLocaleString()} Tokens`), node('small', `版本 ${bot.revision}`));
    const actions = node('td'); const controls = node('div', undefined, 'row-actions');
    if (bot.deleted) {
      const restoreRegistry=button('恢复登记', () => openEditor('restore', bot)); restoreRegistry.disabled ||= !!record && record.state !== 'revoked';
      controls.append(restoreRegistry);
    }
    else {
      const configReg = button('配置登记', () => openEditor('configure', bot)); configReg.disabled ||= !!record && record.state !== 'revoked';
      controls.append(configReg);
      const assign = button('分配', () => openEditor('assign', bot)); assign.disabled ||= !!record && record.state !== 'revoked';
      const deleteReg = button('登记删除', () => openEditor('delete', bot), 'danger'); deleteReg.disabled ||= !!record && record.state !== 'revoked';
      controls.append(assign, button('Host 生命周期', () => document.getElementById(`execution-${bot.id}`)?.scrollIntoView({behavior:'smooth',block:'center'})), deleteReg);
    }
    actions.append(node('span', '管理操作', 'row-label'), controls); row.append(name, owner, state, config, actions); body.append(row);
    const lifecycle = node('tr'); const detail = node('td'); detail.colSpan = 5;
    detail.append(renderExecutionPanel(bot, record, hostReport)); lifecycle.append(detail); body.append(lifecycle);
  }
  table.append(body); wrap.append(table); list.append(wrap);
}
function renderExecutionPanel(bot, record, host) {
  const panel = node('section', undefined, 'execution-panel');
  panel.id = `execution-${bot.id}`;
  const status = latestHostState(bot, host, record);
  panel.append(node('strong', 'Host 执行状态'), node('p', status));
  const currentSnapshot=observedSnapshot(bot,host);
  if(currentSnapshot) panel.append(node('small',`Host Bot：${currentSnapshot.config?.name||bot.name} · 配置${currentSnapshot.configured?'完整':'待补全'} · binding ${currentSnapshot.binding_generation} · snapshot revision ${currentSnapshot.revision}`));
  if (!data.execution?.enabled) {
    panel.append(node('small', '云端执行服务未启用；登记目录功能仍可用。'));
    return panel;
  }
  if (!host || !observationFresh(host)) {
    panel.append(node('small', '等待 Host 提交已认证状态报告。没有新鲜报告时不能创建或重试 Host 操作。'));
  } else {
    const age = Math.max(0, Math.floor(Date.now() / 1000) - host.seen_at);
    panel.append(node('small', `最近 Host 报告：${age} 秒前 · Host revision ${host.observation?.host_revision ?? '—'} · Resource revision ${host.observation?.resource_revision ?? '—'}`));
  }
  const grantState = record?.state || '尚无授权';
  panel.append(node('span', `授权：${grantState}${record?.grant ? ` · 代数 ${record.grant.generation}` : ''}`, `badge ${grantState === 'active' ? 'blue' : 'orange'}`));
  const controls = node('div', undefined, 'row-actions');
  const ownerCanAuthorize = canIssueGrant(bot, host);
  if (!record || grantState === 'revoked') {
    const grantButton = button(record ? '由 Bot Owner 重新授权' : '由 Bot Owner 授权 Host', () => openEditor('grant', bot));
    grantButton.disabled ||= !ownerCanAuthorize;
    controls.append(grantButton);
    if (!ownerCanAuthorize) panel.append(node('small', bot.owner_id !== data.principal_id ? '仅 Bot Owner 可确认 Host 授权；管理员不能代签。' : '缺少新鲜 Host 策略报告或该 Bot 不在该 Host policy 范围内。'));
  } else if (grantState === 'active') {
    const snapshot = observedSnapshot(bot, host, record);
    const operational = observationFresh(host) && !!snapshot;
    if (snapshot?.deleted) {
      const restore = button('排队 Host 恢复', () => queueExecution(bot, record, 'restore', {}).catch(error=>notice(error.message,true)));
      restore.disabled ||= !operational || snapshot.admission !== 'closed' || !!snapshot.active_run || !['stopped','idle'].includes(snapshot.activity);
      controls.append(restore);
    } else {
    const create = button('Host 创建', () => openEditor('host-create', bot)); create.disabled ||= !observationFresh(host) || !!snapshot?.agent_id;
    const configure = button('Host 配置', () => openEditor('host-configure', bot)); configure.disabled ||= !operational || ['running','stopping','unknown'].includes(snapshot?.activity);
    const enable = button('启动 Host Session', () => queueExecution(bot, record, 'enable', {})); enable.disabled ||= !operational || !snapshot?.configured || !!snapshot?.active_run || snapshot?.activity === 'unknown';
    const disable = button('停止并关闭准入', () => queueExecution(bot, record, 'disable', {policy:'cancel'})); disable.disabled ||= !operational || (snapshot?.admission === 'closed' && !snapshot?.active_run);
    const remove = button('Host 删除', () => openEditor('host-delete', bot), 'danger'); remove.disabled ||= !operational || snapshot?.admission !== 'closed' || !!snapshot?.active_run || ['running','stopping','unknown'].includes(snapshot?.activity);
    controls.append(create, configure, enable, disable, remove);
    }
    if (canOwnerAct(bot, host)) controls.append(button('Owner 撤销授权', () => revokeGrant(record), 'danger'));
    if (snapshot?.deleted && canIssueGrant(bot, host)) controls.append(button('新授权后 Host 恢复', () => openEditor('grant', bot)));
  } else if (grantState === 'revoking') {
    panel.append(node('small', '撤销仍待 Host 确认关闭准入和实际运行；完成前不能分配给新 Owner。'));
  }
  if (uncertain?.body?.bot_id === bot.id) controls.append(button('查询原 Host 操作', () => checkUncertainReceipt()));
  panel.append(controls);
  if (record?.snapshot) panel.append(node('small', `最近已确认 Host 回执：${record.snapshot.activity} · binding ${record.snapshot.binding_generation}（仅作历史结果，不代替当前 Host 报告）`));
  panel.append(node('small', '首阶段只管理 Host Product Session；模型调用、共享、IM 与定时任务未开放。'));
  panel.append(node('small', '云端登记是独立投影；Host 删除或恢复不会自动改变登记记录。存在有效授权时，登记分配、删除和恢复由服务端拒绝；Owner 撤销仍须等待 Host ACK。'));
  return panel;
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
  root.append(node('h2', '授权 Hosts'), node('p', '策略来自运营配置；在线和 Bot 运行状态只以经认证的 Host Observation 为准，超过 30 秒显示未知。', 'muted'));
  const cards = node('div', undefined, 'cards');
  for (const host of data.hosts) {
    const card = node('article', undefined, 'panel');
    const report=data.execution?.hosts?.find(item=>item.host_id===host.id); const fresh=observationFresh(report);
    card.append(node('h3', host.name), node('code', host.id), node('p', fresh?'Host 已报告（最近 30 秒内）':'Host 状态未知或报告已过期', `badge ${fresh?'blue':'orange'}`), node('p', `策略 Runtime：${host.runtimes.join(' / ')}`), node('small', `已声明部署权：${host.owner_ids.length} 个用户`));
    if(fresh) card.append(node('small',`Host Report revision ${report.observation.host_revision} · Resource revision ${report.observation.resource_revision} · seen_at ${new Date(report.seen_at*1000).toLocaleString()}`));
    cards.append(card);
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
  const titles = { create: '登记 Bot', configure: '配置登记信息', assign: '分配所属用户与 Host', delete: '删除登记 Bot', restore: '恢复登记 Bot', stop: '关闭 Bot 准入', grant:'Owner 确认 Host 授权', 'host-create':'在 Host 创建 Bot', 'host-configure':'配置 Host Bot', 'host-delete':'删除 Host Bot' };
  $('edit-title').textContent = titles[kind];
  $('edit-description').textContent = kind === 'create' ? '登记 Bot UUID 与归属。之后 Owner 需单独确认 Host 授权，Host 创建与配置是独立步骤。' : bot.name;
  $('save-editor').textContent = { delete: '确认删除登记', restore: '恢复登记', stop: '关闭准入', assign: '确认分配', grant:'确认并签署授权', 'host-create':'排队 Host 创建', 'host-configure':'排队 Host 配置', 'host-delete':'排队 Host 删除' }[kind] || '保存配置';
  $('save-editor').className = ['delete','host-delete'].includes(kind) ? 'danger' : 'primary';
  const record = bot ? executionRecord(bot) : null;
  const hostReport = bot ? executionHost(bot, record) : null;
  const snapshot = bot ? observedSnapshot(bot, hostReport) : null;
  if (kind === 'delete' || kind === 'host-delete') field('输入完整 Bot 名称确认', kind === 'delete' ? 'confirm_name' : 'confirmation', 'text', kind === 'host-delete' ? snapshot?.config?.name : '', kind === 'delete' ? '仅删除云端登记记录。Host 资源必须先按 Host 状态单独删除并完成授权撤销。' : '仅向 Host 请求删除此 Bot；云端登记记录仍单独保留。');
  if (kind === 'restore') $('fields').append(node('p', '恢复后仍为未部署状态，共享关闭，旧权限不恢复。'));
  if (kind === 'stop') $('fields').append(node('p', '仅关闭新的调用准入；这不确认 Host Session 已停止。'));
  if (kind === 'grant') {
    if (!canIssueGrant(bot, hostReport)) $('fields').append(node('p', '无法签署授权：需要当前 Bot Owner 身份、未过期 Host Observation、允许的 Bot UUID 和至少一个 Host root。'));
    else {
      const observation = hostReport.observation;
      const generation = Math.max(0, ...(data.execution.records || []).filter(r=>r.grant?.bot_id===bot.id).map(r=>r.grant.generation)) + 1;
      editing.grantGeneration = generation;
      select('Host root', 'root_id', observation.root_ids.map(id=>[id,id]), observation.root_ids[0]);
      const hostPolicy=data.hosts.find(h=>h.id===bot.host_id);
      const runtimes = observation.supported_runtimes.filter(r=>hostPolicy?.runtimes.includes(r));
      const grantRuntime=select('授权 Runtime', 'runtime', runtimes.map(r=>[r,r==='builtin'?'Builtin':'Codex']), runtimes[0]);
      const grantModel=select('授权模型引用（留空则先建未配置 Bot）', 'model_ref', [['','不授权模型引用']], '');
      const updateGrantModels=()=>{
        const previous=grantModel.value;
        grantModel.replaceChildren();
        for(const [id,label] of [['','不授权模型引用'],...data.model_refs.filter(m=>m.owner_ids.includes(bot.owner_id) && m.runtimes.includes(grantRuntime.value) && (observation.allowed_model_refs||[]).includes(m.id)).map(m=>[m.id,m.label])]) {
          const option=node('option',label); option.value=id; grantModel.append(option);
        }
        grantModel.value=[...grantModel.options].some(o=>o.value===previous)?previous:'';
      };
      grantRuntime.addEventListener('change',updateGrantModels); updateGrantModels();
      const recommendedCap=Math.min(observation.max_daily_tokens,bot.daily_tokens||100);
      const capInput=field('每日 Token 上限', 'max_daily_tokens', 'number', recommendedCap, `按登记 Bot 当前额度建议 ${recommendedCap}；不得超过 Host 上限 ${observation.max_daily_tokens}。`);
      capInput.min='1'; capInput.max=String(observation.max_daily_tokens); capInput.step='1';
      field('授权到期时间（Unix 秒）', 'expires_at', 'number', Math.min(observation.policy_expires_at, Math.floor(Date.now()/1000)+86400), '不能晚于 Host policy 到期时间。');
      $('fields').append(node('p', `权限仅限 ${bot.id}、${bot.owner_id}、Host ${hostReport.host_id} 与相对路径 bots/${bot.id}。授权操作为 create/configure/enable/disable/delete/restore。`, 'muted'));
    }
  }
  $('save-editor').disabled = kind === 'grant' && !canIssueGrant(bot, hostReport);
  let owner;
  let host;
  let runtime;
  let model;
  if (kind === 'create' || kind === 'assign') {
    owner = select('所属用户', 'owner_id', [['', '请选择已注册用户'], ...data.users.map(u => [u.principal_id, u.name || u.principal_id])], bot?.owner_id);
    host = select('运行 Host', 'host_id', [['', '先选择所属用户']], bot?.host_id);
  }
  if (['create','configure','host-create','host-configure'].includes(kind)) {
    const currentConfig = snapshot?.config || bot;
    const name = field('Bot 名称', 'name', 'text', currentConfig?.name); name.maxLength = 60;
    field('说明', 'description', 'textarea', currentConfig?.description);
    const supported = kind.startsWith('host-') ? (hostReport?.observation?.supported_runtimes||[]).filter(value=>record?.grant?.allowed_runtimes?.includes(value)) : [];
    runtime = select('Runtime', 'runtime', (kind.startsWith('host-') ? supported : ['builtin','codex']).map(r=>[r,r==='builtin'?'Builtin':'Codex']), currentConfig?.runtime || supported[0] || 'builtin');
    const grantModels = record?.grant?.allowed_model_refs || [];
    const eligibleModels = data.model_refs.filter(m=>m.owner_ids.includes(bot?.owner_id) && m.runtimes.includes(runtime.value) && (!kind.startsWith('host-') || grantModels.includes(m.id)));
    model = select('模型配置引用', 'model_ref', [['', '待配置（保持停止）'], ...eligibleModels.map(m=>[m.id,m.label])], currentConfig?.model_ref);
    field('系统指令', 'system_prompt', 'textarea', currentConfig?.system_prompt, '只写 Bot 系统指令，不填写 Provider 原始密钥；首阶段不执行付费模型调用。');
    const maxTokens = kind.startsWith('host-') ? Math.min(hostReport?.observation?.max_daily_tokens ?? Infinity,record?.grant?.max_daily_tokens ?? Infinity) : data.capabilities.max_daily_tokens;
    const budget = field('每日 Token 上限', 'daily_tokens', 'number', currentConfig?.daily_tokens ?? '', `不得超过已报告授权上限 ${maxTokens ?? '未知'}。`);
    budget.min = '1'; budget.max=Number.isFinite(maxTokens)?String(maxTokens):''; budget.step = '1';
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
      for (const [id, text] of [['', '待配置（保持停止）'], ...data.model_refs.filter(m => m.owner_ids.includes(ownerId) && m.runtimes.includes(selectedRuntime) && (!kind.startsWith('host-') || record?.grant?.allowed_model_refs?.includes(m.id))).map(m => [m.id, m.label])]) { const o = node('option', text); o.value = id; model.append(o); }
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
async function queueExecution(bot, record, method, params) {
  const host = executionHost(bot, record);
  if (!record || record.state !== 'active' || !observationFresh(host)) throw new Error('缺少有效 Host 授权或最新 Host 状态报告。');
  const snapshot = observedSnapshot(bot, host, record);
  const bindingGeneration = method === 'restore' ? (snapshot?.binding_generation || 0) + 1 : snapshot?.binding_generation || (method === 'create' ? 1 : 0);
  if (!bindingGeneration) throw new Error('Host 尚未报告 Bot binding generation，不能安全提交此操作。');
  const body = { mutation_id: crypto.randomUUID(), grant_id: record.grant.id, grant_generation: record.grant.generation,
    binding_generation: bindingGeneration, expected_host_revision: host.observation.host_revision,
    operation: { method, params } };
  const path = `/api/admin/bots/${bot.id}/execution`;
  await mutate(path, 'POST', body);
}
async function revokeGrant(record) {
  if (!record || busy || uncertain) return;
  if (!confirm('请求 Owner 撤销此 Host 授权？撤销在 Host 确认关闭准入并停止后才生效。')) return;
  await mutate('/api/bots/grants/revoke', 'POST', { grant_id:record.grant.id, expected_generation:record.grant.generation, mutation_id:crypto.randomUUID() });
}
async function mutate(path, method, body) {
  const operation = { path, method, body, execution: path.endsWith('/execution') };
  const mutationToken = token;
  busy = true;
  $('save-editor').disabled = true; render();
  let confirmed = false;
  try {
    const response = await request(path, method, body);
    confirmed = true;
    uncertain = operation.execution && !response.receipt ? {...operation,queued:true,status:response.status||'queued'} : null;
    $('editor').close();
    notice(operation.execution ? response.receipt ? `Host 已回传原操作回执：${response.receipt.status}${response.receipt.code?` · ${response.receipt.code}`:''}。模型调用仍未开放。` : `操作请求已排队（${response.status || 'queued'}）；Host 实际结果仍待原操作回执。保持原操作编号。` : path.endsWith('/grants/revoke') && !response.effective_revoked ? '撤销待 Host ACK：权限尚未确认生效撤销。' : '操作已由服务端确认。');
    await refresh();
  } catch (error) {
    if (mutationToken !== token || error.code === 'STALE_SESSION') throw error;
    if (error.uncertain && !confirmed && token) {
      uncertain = operation;
      if ($('editor').open) $('editor').close();
    }
    $('form-error').textContent = uncertain ? '结果未确认，保持原操作编号并查询回执。' : error.message;
    if (token) notice(confirmed ? `操作已确认，但列表刷新失败：${error.message}。请刷新。` : uncertain ? '请求中断，操作结果未确认。请查询原操作，避免重复创建。' : error.message, true);
    throw error;
  } finally { busy = false; $('save-editor').disabled = false; render(); }
}
async function checkUncertainReceipt() {
  if (!uncertain || busy) return;
  const saved = uncertain;
  try {
    const isExecution = saved.execution || saved.path.endsWith('/execution');
    const receipt = await request(isExecution ? `/api/admin/execution/mutations/${saved.body.mutation_id}` : `/api/admin/mutations/${saved.body.mutation_id}`);
    if (isExecution && !receipt.receipt) {
      uncertain = {...saved,queued:['queued','issued','leased','cancel_pending'].includes(receipt.status),status:receipt.status};
      render();
      notice(`Host 尚未确认原操作（状态：${receipt.status || 'pending'}）。保留原操作编号，不创建新请求。`, true);
      return;
    }
    const hostReceipt=receipt.receipt;
    const effect=hostReceipt ? `Host 回执：${hostReceipt.status}${hostReceipt.code?` · ${hostReceipt.code}`:''}${hostReceipt.snapshot?` · ${hostReceipt.snapshot.activity} / admission ${hostReceipt.snapshot.admission} · revision ${hostReceipt.snapshot.revision}`:''}。模型调用仍未开放。` : '原操作回执已确认。';
    uncertain = null; $('editor').close(); notice(effect); await refresh();
  } catch (error) { if (token) notice(`查询原操作未确认：${error.message}。仍保留原操作编号。`, true); }
}
$('edit-form').addEventListener('submit', async event => {
  event.preventDefault();
  if (!editing || busy || uncertain) return;
  const { kind, bot } = editing;
  const form = Object.fromEntries(new FormData(event.target));
  if (kind === 'grant') {
    const host = executionHost(bot); const observation = host?.observation;
    const generation = editing.grantGeneration;
    if (!canIssueGrant(bot,host) || !Number.isSafeInteger(generation) || !observation.root_ids.includes(form.root_id) ||
        !observation.supported_runtimes.includes(form.runtime) || !(data.hosts.find(item=>item.id===bot.host_id)?.runtimes||[]).includes(form.runtime) ||
        (form.model_ref && (!(observation.allowed_model_refs||[]).includes(form.model_ref) || !data.model_refs.some(item=>item.id===form.model_ref && item.owner_ids.includes(bot.owner_id) && item.runtimes.includes(form.runtime))))) {
      $('form-error').textContent='Host 报告已过期或选择项不在当前授权范围内，请关闭后刷新。'; return;
    }
    const grant = { id: crypto.randomUUID(), generation, scope: host.scope, bot_id:bot.id, root_id:form.root_id,
      relative_path:`bots/${bot.id}`, operations:['create','configure','enable','disable','delete','restore'],
      allowed_runtimes:[form.runtime], allowed_model_refs:form.model_ref?[form.model_ref]:[],
      max_daily_tokens:Number(form.max_daily_tokens), expires_at:Number(form.expires_at) };
    if (!Number.isSafeInteger(grant.max_daily_tokens) || grant.max_daily_tokens < 1 || grant.max_daily_tokens > observation.max_daily_tokens ||
        !Number.isSafeInteger(grant.expires_at) || grant.expires_at <= Math.floor(Date.now()/1000) || grant.expires_at > observation.policy_expires_at) {
      $('form-error').textContent = '授权额度或有效期超出 Host 当前策略。'; return;
    }
    try { await mutate('/api/bots/grants/accept','POST',{grant,expected_generation:generation-1}); }
    catch (error) { $('form-error').textContent = error.message; }
    return;
  }
  if (kind === 'host-create' || kind === 'host-configure' || kind === 'host-delete') {
    let method; let params;
    if (kind === 'host-create' || kind === 'host-configure') {
      const config = {name:form.name,description:form.description,runtime:form.runtime,model_ref:form.model_ref || null,
        system_prompt:form.system_prompt,daily_tokens:Number(form.daily_tokens)};
      const hostCap=Math.min(executionHost(bot)?.observation?.max_daily_tokens??0,executionRecord(bot)?.grant?.max_daily_tokens??0);
      if (!Number.isSafeInteger(config.daily_tokens) || config.daily_tokens < 1 || config.daily_tokens > hostCap) {
        $('form-error').textContent = '请输入 Host 授权范围内的整数额度。'; return;
      }
      method = kind === 'host-create' ? 'create' : 'configure';
      params = kind === 'host-create' ? {...config,resource_expected_revision:executionHost(bot).observation.resource_revision} : config;
    } else { method = 'delete'; params = {confirmation:form.confirmation}; }
    try { await queueExecution(bot,executionRecord(bot),method,params); }
    catch (error) { $('form-error').textContent = error.message; }
    return;
  }
  const body = { ...mutation(bot), ...form };
  if (kind === 'create' || kind === 'configure') {
    body.daily_tokens = Number(body.daily_tokens); body.model_ref = body.model_ref || null;
    if (!Number.isSafeInteger(body.daily_tokens) || body.daily_tokens < 1) { $('form-error').textContent = '请输入有效的整数额度。'; return; }
  }
  if (kind === 'assign') body.confirm_impact = !!form.confirm_impact;
  const path = kind === 'create' ? '/api/admin/bots' : kind === 'configure' ? `/api/admin/bots/${bot.id}` : `/api/admin/bots/${bot.id}/${kind}`;
  try { await mutate(path, kind === 'configure' ? 'PATCH' : 'POST', body); } catch { /* shown in form and notice */ }
});
$('check-receipt').addEventListener('click', checkUncertainReceipt);
$('retry-operation').addEventListener('click', async () => {
  if (!uncertain || busy) return;
  const saved = uncertain;
  try { await mutate(saved.path, saved.method, saved.body); } catch { /* keep the exact operation */ }
});
const closeEditor = () => { if (!busy) { $('editor').close(); editing = null; } };
$('close-editor').addEventListener('click', closeEditor); $('cancel-editor').addEventListener('click', closeEditor);
$('editor').addEventListener('cancel', event => { if (busy) event.preventDefault(); });
$('login-button').addEventListener('click', login);
$('cancel-login').addEventListener('click', cancelLogin);
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
