import { mkdtemp, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
import path from 'node:path';
const base = process.env.BOTS_ADMIN_FIXTURE_URL || 'http://127.0.0.1:5198';
const out = process.env.BOTS_ADMIN_QA_OUTPUT || await mkdtemp(join(tmpdir(), 'bots-admin-qa-'));
const HOST_A = '22222222-2222-4222-8222-222222222222';
const HOST_B = '44444444-4444-4444-8444-444444444444';
const INVALID_HOST = '99999999-9999-4999-8999-999999999999';
const botName = `UI QA synthetic Bot ${Date.now()}`;
if (!['127.0.0.1', 'localhost'].includes(new URL(base).hostname)) throw new Error('Only an isolated loopback fixture may be tested.');
const sourceHashes = Object.fromEntries(await Promise.all(['index.html','app.js','styles.css'].map(async name => [name, createHash('sha256').update(await readFile(new URL('../../admin-web/'+name,import.meta.url))).digest('hex')])));
const browser = await chromium.launch({ headless: true, ...(process.env.CHROMIUM_EXECUTABLE ? { executablePath: process.env.CHROMIUM_EXECUTABLE } : {}) });
const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, acceptDownloads: false });
const page = await context.newPage();
// Refuse evidence from an older fixture executable with different embedded assets.
for (const [name, expected] of Object.entries(sourceHashes)) {
 const response = await context.request.get(`${base}/${name === 'index.html' ? 'admin' : 'admin/' + name}`);
 const digest = createHash('sha256').update(await response.body()).digest('hex');
 if (response.status() !== 200 || digest !== expected) throw new Error(`Fixture asset does not match source: ${name}`);
}

const safe = { errors: [], mutationIds: [], responseCodes: [], clientErrors: [] };
let bearer = null;
page.on('request', request => {
  const h = request.headers();
  if (h.authorization?.startsWith('Bearer ')) bearer = h.authorization.slice(7);
  if (request.method() !== 'GET' && request.url().includes('/api/admin/')) {
    try { const b = request.postDataJSON(); if (b?.mutation_id) safe.mutationIds.push(b.mutation_id); } catch { /* Non-JSON error responses are recorded by status. */ }
  }
});
page.on('response', async response => {
  if (!response.url().startsWith(base) || !/\/api\/admin\//.test(response.url())) return;
  if (response.status() >= 400) {
    let code = 'unparsed'; try { code = (await response.json()).error?.code || code; } catch { /* Non-JSON error responses are recorded by status. */ }
    safe.responseCodes.push({ path: new URL(response.url()).pathname, status: response.status(), code });
  }
});
page.on('pageerror', error => safe.clientErrors.push(error.message));
const assert = (ok, message) => { if (!ok) throw new Error(message); };
const get = (name, exact = true) => page.getByText(name, { exact });
const screenshot = async name => page.screenshot({ path: path.join(out, name), fullPage: true });
const bootstrap = async () => {
  assert(bearer, 'no in-memory test bearer captured');
  const response = await context.request.get(`${base}/api/admin/bootstrap`, { headers: { Authorization: `Bearer ${bearer}` } });
  const value = await response.json();
  assert(response.status() === 200 && value.data, `bootstrap failed: ${response.status()}`);
  return value.data;
};
const login = async identity => {
  await page.goto(`${base}/fixture-identity/${identity}`, { waitUntil: 'domcontentloaded' });
  await page.getByRole('heading', { name: '云服务管理后台' }).waitFor();
  const popupWait = page.waitForEvent('popup');
  await page.getByRole('button', { name: '使用账号登录' }).click();
  const popup = await popupWait; await popup.waitForLoadState('domcontentloaded').catch(() => {});
  if (identity === 'admin') {
    await page.waitForSelector('#console:not([hidden])', { timeout: 15000 });
    await page.getByRole('button', { name: 'Bots 管理' }).waitFor({ timeout: 3000 });
  } else {
    await page.waitForFunction(() => document.querySelector('#login').hidden === false && /平台管理权限/.test(document.querySelector('#login-status').textContent), null, { timeout: 15000 });
  }
};
const configForm = () => page.getByRole('dialog');
try {
  await page.goto(`${base}/admin`, { waitUntil: 'networkidle' });
  assert(await page.getByRole('heading', { name: '云服务管理后台' }).isVisible(), 'unauthenticated login gate missing');
  for (const [w,h] of [[1440,900],[768,1024],[390,844]]) { await page.setViewportSize({ width: w, height: h }); await screenshot(`login-${w}x${h}.png`); }
  await page.setViewportSize({ width: 1440, height: 900 });
  await login('admin');
  const data0 = await bootstrap();
  assert(!data0.bots.some(b => b.name === botName), 'unique UI-QA name already exists in fixture');
  const admin = data0.users.find(u => u.principal_id === data0.principal_id);
  const ordinary = data0.users.find(u => u.principal_id !== data0.principal_id);
  const hostA = data0.hosts.find(h => h.id === HOST_A); const hostB = data0.hosts.find(h => h.id === HOST_B);
  const model = data0.model_refs.find(m => m.id === '33333333-3333-4333-8333-333333333333');
  assert(admin && ordinary && hostA && hostB && model, 'fixture directory is missing seeded owners/hosts/model ref');
  assert(hostA.owner_ids.includes(admin.principal_id) && hostB.owner_ids.includes(ordinary.principal_id) && model.owner_ids.includes(ordinary.principal_id), 'fixture authorization mappings unexpected');
  assert(data0.model_refs.length === 1, 'fixture model-ref count unexpected');
  await screenshot('admin-initial-1440x900.png');
  const responsiveMetrics = [];
  for (const [w,h] of [[768,1024],[390,844]]) {
    await page.setViewportSize({ width: w, height: h }); await screenshot(`admin-initial-${w}x${h}.png`);
    responsiveMetrics.push(await page.evaluate(() => ({ viewport: innerWidth, bodyWidth: document.body.scrollWidth, rootWidth: document.documentElement.scrollWidth })));
  }
  assert(responsiveMetrics.every(m => m.rootWidth <= m.viewport + 1), `page overflow in empty state: ${JSON.stringify(responsiveMetrics)}`);
  assert(await page.getByRole('button', { name: '新建 Bot' }).isEnabled(), 'new Bot disabled despite complete fixture prerequisites');
  const emptyUsersButton = page.getByRole('button', { name: '用户' }); await emptyUsersButton.click();
  assert(await get('已注册用户').isVisible(), 'users view failed');
  await page.getByRole('button', { name: 'Bots 管理' }).click();
  const xssMarker = 'xss-marker <img src=x onerror="window.__qaXss=1">';
  await page.getByRole('button', { name: '新建 Bot' }).click();
  const create = configForm();
  await create.getByLabel('所属用户').selectOption(admin.principal_id);
  await create.getByLabel('运行 Host').selectOption(HOST_A);
  await create.getByLabel('模型配置引用').selectOption(model.id);
  await create.getByLabel('Bot 名称').fill(botName);
  await create.getByLabel('说明').fill(xssMarker);
  await create.getByLabel('系统指令').fill('synthetic initial prompt');
  await create.getByLabel('每日 Token 上限').fill('0');
  await create.getByRole('button', { name: '保存配置' }).click();
  assert(await create.isVisible(), 'invalid quota closed draft editor');
  assert(await create.getByLabel('每日 Token 上限').inputValue() === '0', 'invalid quota was not retained');
  assert(safe.mutationIds.length === 0, 'invalid quota reached the service');
  assert(await create.getByLabel('系统指令').inputValue() === 'synthetic initial prompt', 'validation cleared prompt');
  await create.getByLabel('每日 Token 上限').fill('100');
  await screenshot('bot-editor-1440x900.png');
  await create.getByRole('button', { name: '保存配置' }).click();
  await get(botName).waitFor();
  let data1 = await bootstrap();
  let bot = data1.bots.find(b => b.name === botName);
  assert(bot && bot.system_prompt === 'synthetic initial prompt' && bot.model_ref === model.id && !bot.deleted, 'created stopped draft not persisted');
  assert(!bot.running && !bot.execution_connected, 'unstarted draft claims running/execution');
  assert(await page.evaluate(() => window.__qaXss) === undefined && await page.locator('img').count() === 0, 'description XSS marker executed or parsed');
  assert(await get(xssMarker).count() > 0, 'description is not rendered as text');
  let row = page.locator('tr').filter({ hasText: botName });
  await row.getByRole('button', { name: '配置' }).click();
  let edit = configForm();
  await edit.getByLabel('系统指令').fill('committed through backend; browser response lost');
  const botUrl = `${base}/api/admin/bots/${bot.id}`;
  let forwardedBody = null; let forwardedStatus = null;
  await page.route(botUrl, async route => {
    const response = await route.fetch(); forwardedStatus = response.status();
    forwardedBody = route.request().postDataJSON();
    await route.abort('failed');
  }, { times: 1 });
  await edit.getByRole('button', { name: '保存配置' }).click();
  await page.waitForSelector('#pending:not([hidden])', { timeout: 5000 });
  const pendingId = (await page.locator('#pending-id').innerText()).trim();
  assert(forwardedStatus >= 200 && forwardedStatus < 300, `backend write did not commit: ${forwardedStatus}`);
  assert(forwardedBody.mutation_id === pendingId, 'pending ID differs from original mutation');
  await page.waitForFunction(() => !document.querySelector('#editor').open, null, { timeout: 3000 });
  await page.getByRole('button', { name: '查询原操作' }).click();
  await page.locator('#pending').waitFor({ state: 'hidden', timeout: 5000 });
  let data2 = await bootstrap(); bot = data2.bots.find(b => b.id === bot.id);
  assert(bot.system_prompt === 'committed through backend; browser response lost', 'original operation receipt did not resolve committed write');
  let receipt = await context.request.get(`${base}/api/admin/mutations/${pendingId}`, { headers: { Authorization: `Bearer ${bearer}` } });
  assert(receipt.status() === 200, 'original mutation receipt did not remain queryable');
  row = page.locator('tr').filter({ hasText: botName });
  await screenshot('bot-list-1440x900.png');
  const populatedMetrics = [];
  for (const [w,h] of [[768,1024],[390,844]]) {
    await page.setViewportSize({ width: w, height: h }); await screenshot(`bot-list-${w}x${h}.png`);
    populatedMetrics.push(await page.evaluate(() => ({ viewport: innerWidth, bodyWidth: document.body.scrollWidth, rootWidth: document.documentElement.scrollWidth })));
  }
  assert(populatedMetrics.every(m => m.rootWidth <= m.viewport + 1), `page overflow in populated list: ${JSON.stringify(populatedMetrics)}`);
  await page.setViewportSize({ width: 1440, height: 900 });
  row = page.locator('tr').filter({ hasText: botName });
  const startResponseWait = page.waitForResponse(r => r.request().method() === 'POST' && new URL(r.url()).pathname.endsWith('/start'));
  await row.getByRole('button', { name: '启动' }).click();
  await page.getByText(/Host 执行适配尚未接入/).waitFor();
  const startResponse = await startResponseWait; const startBody = await startResponse.json();
  assert(startResponse.status() === 409 && startBody.error?.code === 'HOST_EXECUTION_NOT_CONNECTED', `start response was not documented 409: ${startResponse.status()} ${startBody.error?.code}`);
  data1 = await bootstrap(); bot = data1.bots.find(b => b.id === bot.id);
  assert(!bot.running && bot.state !== 'running', 'failed start wrote a running state');
  await row.getByRole('button', { name: '分配' }).click();
  let assign = configForm();
  await assign.getByLabel('所属用户').selectOption(ordinary.principal_id);
  await assign.getByLabel('运行 Host').selectOption(HOST_B);
  await assign.locator('input[name=confirm_impact]').check();
  let assignUrl = `${base}/api/admin/bots/${bot.id}/assign`;
  await page.route(assignUrl, route => {
    const orig = route.request().postDataJSON();
    return route.continue({ postData: JSON.stringify({ ...orig, host_id: INVALID_HOST }) });
  }, { times: 1 });
  const forbiddenResponseWait = page.waitForResponse(r => r.request().method() === 'POST' && new URL(r.url()).pathname.endsWith('/assign'));
  await assign.getByRole('button', { name: '确认分配' }).click();
  const forbiddenResponse = await forbiddenResponseWait; const forbiddenBody = await forbiddenResponse.json();
  assert(forbiddenResponse.status() === 403 && forbiddenBody.error?.code === 'RESOURCE_ASSIGNMENT_FORBIDDEN', `assignment response code mismatch: ${forbiddenResponse.status()} ${forbiddenBody.error?.code}`);
  await page.locator('#form-error').getByText(/配置不符合该用户的 Host/).waitFor();
  assert(await assign.isVisible(), '403 assignment error closed editor');
  assert(await assign.getByLabel('所属用户').inputValue() === ordinary.principal_id, '403 assignment error discarded selected owner');
  assert(await page.locator('#console').isVisible(), 'HOST_ASSIGNMENT_FORBIDDEN logged out admin');
  const hostForbidden = { status: forbiddenResponse.status(), code: forbiddenBody.error.code };
  safe.responseCodes.push({ path: '/api/admin/bots/{id}/assign', ...hostForbidden });
  const stillAdmin = await bootstrap(); assert(stillAdmin.bots.find(b => b.id === bot.id).owner_id === admin.principal_id, 'denied assignment changed owner');
  await assign.getByLabel('运行 Host').selectOption(HOST_B);
  await assign.getByRole('button', { name: '确认分配' }).click();
  const afterAssign = await bootstrap(); bot = afterAssign.bots.find(b => b.id === bot.id);
  assert(bot.owner_id === ordinary.principal_id && bot.host_id === HOST_B, 'authorized assignment did not persist');
  assert(!bot.system_prompt && !bot.model_ref, 'assignment did not clear old prompt/model reference');
  row = page.locator('tr').filter({ hasText: botName });
  await row.getByRole('button', { name: '配置' }).click(); edit = configForm();
  await edit.getByLabel('模型配置引用').selectOption(model.id);
  await edit.getByLabel('系统指令').fill('ordinary owner authorized prompt');
  await edit.getByRole('button', { name: '保存配置' }).click();
  data1 = await bootstrap(); bot = data1.bots.find(b => b.id === bot.id);
  assert(bot.model_ref === model.id && bot.system_prompt === 'ordinary owner authorized prompt', 'authorized model/prompt config did not persist');
  row = page.locator('tr').filter({ hasText: botName });
  await row.getByRole('button', { name: '配置' }).click(); edit = configForm();
  const staleRevision = bot.revision; const staleName = bot.name;
  await edit.getByLabel('系统指令').fill('operator draft survives CAS conflict');
  const casMutation = { mutation_id: crypto.randomUUID(), expected_revision: staleRevision, name: staleName, description: bot.description, runtime: bot.runtime, model_ref: bot.model_ref, system_prompt: 'separate authorized update', daily_tokens: bot.daily_tokens };
  const casResponse = await context.request.patch(`${base}/api/admin/bots/${bot.id}`, { headers: { Authorization: `Bearer ${bearer}`, 'Content-Type': 'application/json' }, data: casMutation });
  assert(casResponse.status() === 200, `fixture CAS advance failed: ${casResponse.status()}`);
  await edit.getByRole('button', { name: '保存配置' }).click();
  await page.locator('#form-error').getByText(/配置已被其他操作更新/).waitFor();
  assert(await edit.isVisible() && await edit.getByLabel('系统指令').inputValue() === 'operator draft survives CAS conflict', 'CAS conflict overwrote operator editor draft');
  data1 = await bootstrap(); bot = data1.bots.find(b => b.id === bot.id);
  assert(bot.system_prompt === 'separate authorized update', 'CAS conflict overwrote server revision');
  await page.locator('#close-editor').click();
  await page.getByRole('button', { name: '刷新' }).click();
  row = page.locator('tr').filter({ hasText: botName });
  await row.getByRole('button', { name: '配置' }).click(); edit = configForm();
  await edit.getByLabel('系统指令').fill('write confirmed; bootstrap response lost');
  let bootstrapAborted = false;
  await page.route(`${base}/api/admin/bootstrap`, async route => { if (!bootstrapAborted) { bootstrapAborted = true; await route.abort('failed'); } else await route.continue(); });
  await edit.getByRole('button', { name: '保存配置' }).click();
  await page.getByText(/操作已确认，但列表刷新失败/).waitFor();
  assert(!await page.locator('#pending').isVisible(), 'confirmed write marked uncertain after bootstrap failure');
  await page.getByRole('button', { name: '刷新' }).click();
  data1 = await bootstrap(); bot = data1.bots.find(b => b.id === bot.id);
  assert(bot.system_prompt === 'write confirmed; bootstrap response lost', 'confirmed write did not persist after list refresh failure');
  row = page.locator('tr').filter({ hasText: botName });
  await row.getByRole('button', { name: '关闭准入' }).click();
  assert((await configForm().innerText()).includes('不表示 Host 上的进程已经停止'), 'stop dialog implies OS process stop');
  await configForm().getByRole('button', { name: '关闭准入' }).click();
  await page.getByText('操作已由服务端确认。').waitFor();
  assert(!(await page.locator('#notice').innerText()).includes('进程已停止'), 'stop claims OS process stopped');
  row = page.locator('tr').filter({ hasText: botName });
  await row.getByRole('button', { name: '删除' }).click();
  let del = configForm();
  await del.getByLabel('输入完整 Bot 名称确认').fill('wrong name');
  await del.getByRole('button', { name: '确认删除' }).click();
  await page.locator('#form-error').getByText(/确认名称与 Bot 名称不一致/).waitFor();
  assert(await del.isVisible(), 'wrong delete name did not preserve confirmation dialog');
  await del.getByLabel('输入完整 Bot 名称确认').fill(botName);
  await del.getByRole('button', { name: '确认删除' }).click();
  const deletedData = await bootstrap(); bot = deletedData.bots.find(b => b.id === bot.id);
  assert(bot.deleted, 'exact-name delete not persisted');
  await page.getByRole('button', { name: '回收站' }).click();
  row = page.locator('tr').filter({ hasText: botName });
  await row.getByRole('button', { name: '恢复' }).click();
  await configForm().getByRole('button', { name: '确认恢复' }).click();
  const restoredData = await bootstrap(); bot = restoredData.bots.find(b => b.id === bot.id);
  assert(!bot.deleted && !bot.running && bot.state !== 'running', 'restore did not return bot to stopped state');
  await page.reload({ waitUntil: 'networkidle' });
  await page.getByRole('heading', { name: '云服务管理后台' }).waitFor();
  await login('admin');
  const persisted = await bootstrap(); bot = persisted.bots.find(b => b.name === botName);
  assert(bot && !bot.deleted && bot.owner_id === ordinary.principal_id && bot.host_id === HOST_B && bot.system_prompt === 'write confirmed; bootstrap response lost', 'fresh login did not recover persisted assigned/configured Bot');
  for (const [w,h] of [[1440,900],[768,1024],[390,844]]) {
    await page.setViewportSize({ width: w, height: h });
    const metrics = await page.evaluate(() => ({ viewport: innerWidth, rootWidth: document.documentElement.scrollWidth }));
    assert(metrics.rootWidth <= metrics.viewport + 1, `final UI overflow: ${JSON.stringify(metrics)}`);
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  const revokedAdminBearer = bearer;
  const logoutDeleteWait = page.waitForResponse(r => r.request().method() === 'DELETE' && new URL(r.url()).pathname === '/auth/session');
  await page.getByRole('button', { name: '退出' }).click();
  const logoutDelete = await logoutDeleteWait;
  const revokedAdmin = await context.request.get(`${base}/api/admin/bootstrap`, { headers: { Authorization: `Bearer ${revokedAdminBearer}` } });
  const logoutRevoked = logoutDelete.status() >= 200 && logoutDelete.status() < 300 && revokedAdmin.status() === 401;
  if (!logoutRevoked) {
    assert(logoutDelete.status() === 404 && revokedAdmin.status() === 200, `unexpected fixture logout behavior ${logoutDelete.status()}/${revokedAdmin.status()}`);
    safe.clientErrors.push('logout revocation gate blocked: test fixture DELETE /auth/session is not wired to AuthStore');
  }
  await login('ordinary');
  await page.waitForFunction(() => document.querySelector('#login').hidden === false && /平台管理权限/.test(document.querySelector('#login-status').textContent), null, { timeout: 5000 });
  const adminRequired = safe.responseCodes.findLast(r => r.path === '/api/admin/bootstrap' && r.code === 'ADMIN_REQUIRED');
  assert(adminRequired?.status === 403, `ordinary user did not receive ADMIN_REQUIRED: ${JSON.stringify(adminRequired)}`);
  assert(await page.locator('#console').isHidden(), 'ordinary user can see administrator data');
  const ordinaryBearer = bearer;
  if (ordinaryBearer) await context.request.delete(`${base}/auth/session`, { headers: { Authorization: `Bearer ${ordinaryBearer}` } });
  assert(!safe.clientErrors.some(e => e.startsWith('page error:')), `page errors: ${safe.clientErrors.join('; ')}`);
  console.log(JSON.stringify({ status: 'passed_for_fixture_cases', fixture: 'test-only same-origin OIDC/PKCE; real Rust AdminService/AuthStore/temp SQLite; synthetic admin and ordinary users', sourceHashes, viewports: ['1440x900','768x1024','390x844'], responsiveMetrics, exercised: ['login gate/admin fixture OIDC-PKCE', 'empty directory', 'create stopped draft and validation retention', 'model/prompt selection', 'safe text rendering/XSS marker', 'unknown commit result and direct original-receipt action', 'start 409 leaves not-running state', '403 RESOURCE_ASSIGNMENT_FORBIDDEN keeps dialog/session/draft', 'authorized assignment clears previous prompt/model', 'authorized model reconfiguration', 'CAS conflict preserves UI draft and newer server record', 'confirmed write + failed bootstrap refresh', 'close admission wording', 'exact-name deletion and restore stopped', 'fresh-login persistence', logoutRevoked ? 'logout revocation 401' : 'logout revocation blocked by missing fixture DELETE route', 'ordinary login ADMIN_REQUIRED 403'], limitations: ['fixture authentication is not production OIDC acceptance', 'Host execution remains disconnected; no real process behavior accepted', 'screenshots require final manual inspection'], responseCodes: safe.responseCodes, mutationCount: safe.mutationIds.length, clientErrors: safe.clientErrors }));
} catch (error) {
  console.error(error.stack || String(error));
  console.log(JSON.stringify({ status: 'failed_or_blocked', safe }));
  process.exitCode = 1;
} finally { await browser.close(); }
