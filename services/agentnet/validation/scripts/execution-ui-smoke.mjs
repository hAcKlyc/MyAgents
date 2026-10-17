import { createHash } from 'node:crypto';
import { mkdtemp, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const base = process.env.EXECUTION_UI_FIXTURE_URL || 'http://127.0.0.1:5199';
if (!['127.0.0.1', 'localhost'].includes(new URL(base).hostname)) throw new Error('Only a loopback synthetic fixture is allowed.');
const output = process.env.EXECUTION_UI_OUTPUT || await mkdtemp(join(tmpdir(), 'execution-ui-'));
const webDir = new URL('../../admin-web/', import.meta.url);
const expectedHashes = Object.fromEntries(await Promise.all(['app.js', 'styles.css'].map(async name => {
  const bytes = await readFile(new URL(name, webDir));
  return [name, createHash('sha256').update(bytes).digest('hex')];
})));
for (const [name, hash] of Object.entries(expectedHashes)) {
  const response = await fetch(`${base}/admin/${name}`);
  const servedHash = createHash('sha256').update(Buffer.from(await response.arrayBuffer())).digest('hex');
  if (!response.ok || servedHash !== hash) throw new Error(`Served asset mismatch: ${name}`);
}

const browser = await chromium.launch({ headless: true, ...(process.env.CHROMIUM_EXECUTABLE ? { executablePath: process.env.CHROMIUM_EXECUTABLE } : {}) });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
let safeBootstrap;
const apiResponses = [];
page.on('response', async response => {
  if (new URL(response.url()).pathname !== '/api/admin/bootstrap') return;
  apiResponses.push(response.status());
  if (response.status() !== 200) return;
  const payload = await response.json();
  const b = payload?.data;
  if (!b) return;
  safeBootstrap = {
    principal_id: b.principal_id,
    bots: (b.bots || []).map(x => ({ id: x.id, owner_id: x.owner_id, host_id: x.host_id, name: x.name, runtime: x.runtime, model_ref: x.model_ref, daily_tokens: x.daily_tokens, deleted: x.deleted })),
    users: (b.users || []).map(x => ({ principal_id: x.principal_id })),
    hosts: (b.hosts || []).map(x => ({ id: x.id, owner_ids: x.owner_ids })),
    model_refs: (b.model_refs || []).map(x => ({ id: x.id, owner_ids: x.owner_ids, runtimes: x.runtimes })),
    execution: {
      enabled: b.execution?.enabled,
      hosts: (b.execution?.hosts || []).map(x => ({
        host_id: x.host_id,
        scope: x.scope && { network_id: x.scope.network_id, host_owner_id: x.scope.host_owner_id, host_device_id: x.scope.host_device_id },
        seen_at: x.seen_at,
        observation: x.observation && {
          host_revision: x.observation.host_revision,
          resource_revision: x.observation.resource_revision,
          root_ids: x.observation.root_ids,
          allowed_bot_ids: x.observation.allowed_bot_ids,
          allowed_model_refs: x.observation.allowed_model_refs,
          supported_runtimes: x.observation.supported_runtimes,
          max_daily_tokens: x.observation.max_daily_tokens,
          policy_expires_at: x.observation.policy_expires_at,
          snapshots: (x.observation.snapshots || []).map(s => ({ bot_id: s.bot_id, agent_id: s.agent_id, activity: s.activity, admission: s.admission, configured: s.configured, runnable: s.runnable, deleted: s.deleted, binding_generation: s.binding_generation, revision: s.revision, unsupported_reason: s.unsupported_reason })),
        },
      })),
      records: (b.execution?.records || []).map(x => ({ state: x.state, bot_id: x.grant?.bot_id, grant_id: x.grant?.id, generation: x.grant?.generation, grant_scope: x.grant?.scope && { network_id: x.grant.scope.network_id, host_owner_id: x.grant.scope.host_owner_id, host_device_id: x.grant.scope.host_device_id } })),
    },
  };
});
const clientErrors = [];
page.on('pageerror', e => clientErrors.push(e.message));

try {
  await page.goto(`${base}/fixture-identity/admin`, { waitUntil: 'domcontentloaded' });
  await page.getByRole('heading', { name: '云服务管理后台' }).waitFor();
  await page.getByRole('button', { name: '使用账号登录' }).click();
  await page.waitForSelector('#console:not([hidden])', { timeout: 15000 });
  await page.getByRole('button', { name: '刷新' }).click();
  await page.waitForTimeout(100);
  if (!safeBootstrap) throw new Error('No sanitized successful bootstrap observed.');

  const widths = [];
  for (const [width, height] of [[1440, 900], [768, 1024], [390, 844]]) {
    await page.setViewportSize({ width, height });
    const shot = join(output, `admin-${width}x${height}.png`);
    await page.screenshot({ path: shot, fullPage: true });
    widths.push(await page.evaluate(() => ({ viewport: innerWidth, body: document.body.scrollWidth, document: document.documentElement.scrollWidth, shot: location.pathname })));
  }
  const mobile = page.getByRole('button', { name: 'Bots 管理' });
  await mobile.focus();
  await page.keyboard.press('Enter');
  await page.getByRole('button', { name: '新建 Bot' }).waitFor();
  await page.getByRole('button', { name: '新建 Bot' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.waitFor();
  const initialFocus = await page.evaluate(() => document.activeElement?.getAttribute('aria-label') || document.activeElement?.textContent?.trim() || document.activeElement?.tagName);
  await dialog.getByRole('button', { name: '保存配置' }).click();
  const requiredValidation = await dialog.innerText();
  const invalidSubmitKeptDialog = await dialog.isVisible();
  await page.keyboard.press('Escape');
  const escapeClosed = await dialog.isHidden();
  const botsNav = page.getByRole('button', { name: 'Bots 管理' });
  await botsNav.click();
  await page.getByRole('button', { name: '刷新' }).click();
  await page.waitForTimeout(100);
  const boot = safeBootstrap;
  const bot = boot.bots.find(x => x.name === '合成生命周期 Bot' && !x.deleted);
  const host = boot.execution.hosts.find(x => x.host_id === bot?.host_id);
  const checks = {
    ownerMatchesPrincipal: bot?.owner_id === boot.principal_id && host?.scope?.host_owner_id === boot.principal_id,
    deviceMatchesConfiguredHost: bot?.host_id === host?.scope?.host_device_id && host?.host_id === bot?.host_id,
    botOnAllowlist: !!host?.observation?.allowed_bot_ids?.includes(bot?.id),
    rootAvailable: !!host?.observation?.root_ids?.length,
    runtimeAvailable: !!host?.observation?.supported_runtimes?.includes(bot?.runtime || 'builtin'),
    modelRefAuthorized: !!boot.model_refs.some(m => m.owner_ids.includes(bot?.owner_id) && m.runtimes.includes(bot?.runtime || 'builtin') && host?.observation?.allowed_model_refs?.includes(m.id)),
    reportFresh: Math.floor(Date.now() / 1000) - (host?.seen_at || 0) <= 30,
    executionEnabled: boot.execution.enabled,
  };
  const grantButton = page.getByRole('button', { name: '由 Bot Owner 授权 Host' });
  const grantButtonEnabled = (await grantButton.count()) > 0 && await grantButton.isEnabled();
  let lifecycle = { checks, grantButtonEnabled, hostLifecycle: 'blocked_before_grant', commandResults: [] };
  const grantAlreadyActive = boot.execution.records.some(x => x.bot_id === bot?.id && x.state === 'active');
  if (grantAlreadyActive) {
    lifecycle.grantAccepted = true;
    lifecycle.hostLifecycle = 'grant_accepted_before_this_run';
  } else if (Object.values(checks).every(Boolean) && grantButtonEnabled) {
    await grantButton.click();
    const grantDialog = page.getByRole('dialog');
    await grantDialog.getByLabel('Host root').selectOption(host.observation.root_ids[0]);
    await grantDialog.getByLabel('授权 Runtime').selectOption(bot.runtime);
    const grantModel = boot.model_refs.find(m => m.owner_ids.includes(bot.owner_id) && m.runtimes.includes(bot.runtime) && host.observation.allowed_model_refs.includes(m.id));
    if (grantModel) await grantDialog.getByLabel('授权模型引用（留空则先建未配置 Bot）').selectOption(grantModel.id);
    await grantDialog.getByLabel('每日 Token 上限').fill(String(Math.min(bot.daily_tokens || 100, host.observation.max_daily_tokens)));
    await grantDialog.getByRole('button', { name: '确认并签署授权' }).click();
    await page.getByText(/授权：active/).waitFor({ timeout: 10000 });
    lifecycle.grantAccepted = true;
    lifecycle.hostLifecycle = 'grant_accepted';
  }

  if (lifecycle.grantAccepted) {
    const model = boot.model_refs.find(m => m.owner_ids.includes(bot.owner_id) && m.runtimes.includes(bot.runtime) && host.observation.allowed_model_refs.includes(m.id));
    const controls = await browser.newPage();
    await controls.goto(`${base}/fixture-control`);
    await controls.getByRole('button', { name: '继续 Host 命令' }).click();
    await page.waitForTimeout(1300);
    await page.getByRole('button', { name: '刷新' }).click();
    await page.waitForTimeout(200);
    lifecycle.priorPendingSnapshot = safeBootstrap.execution.hosts[0].observation.snapshots.find(s => s.bot_id === bot.id);
    const executionRequests = [];
    page.on('request', request => {
      const url = new URL(request.url());
      if (request.method() === 'POST' && /\/api\/admin\/bots\/[^/]+\/execution$/.test(url.pathname)) {
        let mutationId = null; try { mutationId = request.postDataJSON()?.mutation_id || null; } catch { /* Never log request bodies. */ }
        executionRequests.push({ mutationId, path: url.pathname });
      }
    });
    const initialSnapshot = host.observation.snapshots.find(s => s.bot_id === bot.id);
    let createReceiptResolved = !!initialSnapshot?.agent_id;
    let hostDialog;
    if (createReceiptResolved) lifecycle.commandResults.push({ operation: 'create', persistedBeforeThisRun: true, snapshot: initialSnapshot });
    if (!createReceiptResolved) {
    await controls.getByRole('button', { name: /暂停 Host 命令/ }).click();
    await page.getByRole('button', { name: 'Host 创建' }).click({ timeout: 5000 });
    hostDialog = page.getByRole('dialog');
    await hostDialog.getByLabel('模型配置引用').selectOption(model.id);
    await hostDialog.getByLabel('系统指令').fill('Synthetic lifecycle browser test only');
    await hostDialog.getByRole('button', { name: '排队 Host 创建' }).click();
    await page.locator('#pending:not([hidden])').waitFor({ timeout: 5000 });
    const createMutationId = (await page.locator('#pending-id').innerText()).trim();
    await page.getByRole('button', { name: '查询原操作' }).click();
    await page.locator('#pending:not([hidden])').waitFor();
    const pendingMutationIdStable = (await page.locator('#pending-id').innerText()).trim() === createMutationId;
    const requestCountWhilePending = executionRequests.length;
    await page.getByRole('button', { name: 'Host 创建' }).click().catch(() => {});
    const pendingBlocksNewEditor = await page.getByRole('dialog').count() === 0;
    const noNewMutationWhilePending = executionRequests.length === requestCountWhilePending;
    await controls.getByRole('button', { name: '继续 Host 命令' }).click();
    for (let i = 0; i < 8 && !createReceiptResolved; i++) {
      await page.waitForTimeout(1100);
      const query = page.locator('#check-receipt');
      if (await page.locator('#pending').isVisible() && await query.count() && await query.isVisible()) await query.click();
      createReceiptResolved = await page.locator('#pending').isHidden();
    }
    if (createReceiptResolved) {
      lifecycle.commandResults.push({ operation: 'create', mutationId: createMutationId, receiptResolved: true, pendingMutationIdStable, pendingBlocksNewEditor, noNewMutationWhilePending });
      await page.getByRole('button', { name: '刷新' }).click();
      await page.waitForTimeout(1100);
    } else {
      lifecycle.commandResults.push({ operation: 'create', mutationId: createMutationId, receiptResolved: false, pendingMutationIdStable, pendingBlocksNewEditor, noNewMutationWhilePending });
    }
    }

    if (createReceiptResolved) {
      await controls.getByRole('button', { name: '继续 Host 命令' }).click();
      await page.waitForTimeout(1200);
      await page.getByRole('button', { name: '刷新' }).click();
      await page.waitForTimeout(150);
      await controls.getByRole('button', { name: /暂停 Host 命令/ }).click();
      await page.getByRole('button', { name: 'Host 配置' }).click();
      hostDialog = page.getByRole('dialog');
      await hostDialog.getByLabel('模型配置引用').selectOption(model.id);
      await hostDialog.getByLabel('系统指令').fill('Paused and resumed synthetic configure');
      await hostDialog.getByRole('button', { name: '排队 Host 配置' }).click();
      await page.locator('#pending:not([hidden])').waitFor({ timeout: 5000 });
      const pausedId = (await page.locator('#pending-id').innerText()).trim();
      const pausedQuery = page.locator('#check-receipt');
      if (await pausedQuery.isVisible()) await pausedQuery.click();
      const pausedIdStable = (await page.locator('#pending-id').innerText()).trim() === pausedId;
      const requestCountWhilePending = executionRequests.length;
      await page.getByRole('button', { name: 'Host 配置' }).click().catch(() => {});
      const pendingBlocksNewEditor = await page.getByRole('dialog').count() === 0;
      const noNewMutationWhilePending = executionRequests.length === requestCountWhilePending;
      await controls.getByRole('button', { name: '继续 Host 命令' }).click();
      let pausedReceiptResolved = false;
      for (let i = 0; i < 8 && !pausedReceiptResolved; i++) {
        await page.waitForTimeout(1100);
        const query = page.locator('#check-receipt');
        if (await page.locator('#pending').isVisible() && await query.isVisible()) await query.click();
        pausedReceiptResolved = await page.locator('#pending').isHidden();
      }
      lifecycle.commandResults.push({ operation: 'configure-pause-resume', mutationId: pausedId, resolved: pausedReceiptResolved, pendingIdStable: pausedIdStable, pendingBlocksNewEditor, noNewMutationWhilePending });
      if (!pausedReceiptResolved) createReceiptResolved = false;
      await page.getByRole('button', { name: '刷新' }).click(); await page.waitForTimeout(1100);
    }

    if (createReceiptResolved) {
      const configButton = page.getByRole('button', { name: 'Host 配置' });
      await configButton.click(); hostDialog = page.getByRole('dialog');
      await hostDialog.getByLabel('模型配置引用').selectOption(model.id);
      await hostDialog.getByLabel('系统指令').fill('Configured by synthetic UI test');
      await controls.getByRole('button', { name: '下一命令产生 CAS conflict' }).click();
      await hostDialog.getByRole('button', { name: '排队 Host 配置' }).click();
      await page.locator('#pending:not([hidden])').waitFor({ timeout: 5000 });
      const conflictId = (await page.locator('#pending-id').innerText()).trim();
      let conflictText = '';
      for (let i = 0; i < 8 && await page.locator('#pending').isVisible(); i++) {
        await page.waitForTimeout(1100);
        const query = page.locator('#check-receipt');
        if (!await query.count() || !await query.isVisible()) break;
        await query.click();
        conflictText = await page.locator('#notice').innerText().catch(() => '');
      }
      lifecycle.commandResults.push({ operation: 'configure-cas-conflict', mutationId: conflictId, resolved: await page.locator('#pending').isHidden(), notice: conflictText });
      await page.getByRole('button', { name: '刷新' }).click(); await page.waitForTimeout(1100);

      const enableButton = page.getByRole('button', { name: '启动 Host Session' });
      if (await enableButton.isEnabled()) {
        await controls.getByRole('button', { name: '继续 Host 命令' }).click();
        await enableButton.click();
        await page.locator('#pending:not([hidden])').waitFor({ timeout: 5000 });
        const enableId = (await page.locator('#pending-id').innerText()).trim();
        let enableNotice = '';
        for (let i = 0; i < 8 && await page.locator('#pending').isVisible(); i++) {
          await page.waitForTimeout(1100); const query = page.locator('#check-receipt'); if (!await query.count() || !await query.isVisible()) break; await query.click();
          enableNotice = await page.locator('#notice').innerText().catch(() => '');
        }
        await page.getByRole('button', { name: '刷新' }).click(); await page.waitForTimeout(300);
        const afterEnable = safeBootstrap.execution.hosts[0].observation.snapshots.find(s => s.bot_id === bot.id);
        lifecycle.commandResults.push({ operation: 'enable', mutationId: enableId, resolved: await page.locator('#pending').isHidden(), notice: enableNotice, activity: afterEnable?.activity, admission: afterEnable?.admission, label: await page.locator(`#execution-${bot.id}`).innerText() });

        const disable = page.getByRole('button', { name: '停止并关闭准入' });
        if (await disable.isEnabled()) {
          await disable.click(); await page.locator('#pending:not([hidden])').waitFor({ timeout: 5000 });
          const disableId = (await page.locator('#pending-id').innerText()).trim();
          for (let i = 0; i < 8 && await page.locator('#pending').isVisible(); i++) { await page.waitForTimeout(1100); const query = page.locator('#check-receipt'); if (!await query.count() || !await query.isVisible()) break; await query.click(); }
          await page.getByRole('button', { name: '刷新' }).click(); await page.waitForTimeout(300);
          lifecycle.commandResults.push({ operation: 'disable', mutationId: disableId, resolved: await page.locator('#pending').isHidden(), snapshot: safeBootstrap.execution.hosts[0].observation.snapshots.find(s => s.bot_id === bot.id) });
        }

        const deleteButton = page.getByRole('button', { name: 'Host 删除' });
        if (await deleteButton.isEnabled()) {
          await deleteButton.click(); hostDialog = page.getByRole('dialog');
          await hostDialog.getByLabel('输入完整 Bot 名称确认').fill('合成生命周期 Bot');
          await hostDialog.getByRole('button', { name: '排队 Host 删除' }).click();
          await page.locator('#pending:not([hidden])').waitFor({ timeout: 5000 });
          const deleteId = (await page.locator('#pending-id').innerText()).trim();
          for (let i = 0; i < 8 && await page.locator('#pending').isVisible(); i++) { await page.waitForTimeout(1100); const query = page.locator('#check-receipt'); if (!await query.count() || !await query.isVisible()) break; await query.click(); }
          lifecycle.commandResults.push({ operation: 'host-delete', mutationId: deleteId, resolved: await page.locator('#pending').isHidden() });
          if (await page.locator('#pending').isHidden()) {
            page.once('dialog', d => d.accept());
            await page.getByRole('button', { name: 'Owner 撤销授权' }).click();
            await page.waitForTimeout(2200); await page.getByRole('button', { name: '刷新' }).click(); await page.waitForTimeout(300);
            lifecycle.revocation = safeBootstrap.execution.records.map(r => ({ state: r.state, bot_id: r.bot_id }));
            if (safeBootstrap.execution.records.some(r => r.state === 'revoked')) {
              await page.getByRole('button', { name: '由 Bot Owner 重新授权' }).click();
              const freshGrant = page.getByRole('dialog');
              await freshGrant.getByLabel('Host root').selectOption(host.observation.root_ids[0]);
              await freshGrant.getByLabel('授权 Runtime').selectOption(bot.runtime);
              await freshGrant.getByLabel('授权模型引用（留空则先建未配置 Bot）').selectOption(model.id);
              await freshGrant.getByRole('button', { name: '确认并签署授权' }).click();
              await page.getByText(/授权：active/).waitFor({ timeout: 10000 });
              const restoreButton = page.getByRole('button', { name: '排队 Host 恢复' });
              if (await restoreButton.isEnabled()) {
                await restoreButton.click(); await page.locator('#pending:not([hidden])').waitFor({ timeout: 5000 });
                const restoreId = (await page.locator('#pending-id').innerText()).trim();
                for (let i = 0; i < 8 && await page.locator('#pending').isVisible(); i++) { await page.waitForTimeout(1100); const query = page.locator('#check-receipt'); if (!await query.count() || !await query.isVisible()) break; await query.click(); }
                await page.getByRole('button', { name: '刷新' }).click(); await page.waitForTimeout(300);
                lifecycle.commandResults.push({ operation: 'fresh-grant-restore', mutationId: restoreId, resolved: await page.locator('#pending').isHidden(), snapshot: safeBootstrap.execution.hosts[0].observation.snapshots.find(s => s.bot_id === bot.id) });
              }
            }
          }
        }
      }
    }
    // Exercise the client-side 30-second freshness gate by advancing only this
    // isolated page's clock. The fixture's server clock and Host observation
    // remain untouched.
    await page.evaluate(() => {
      window.__qaDateNow = Date.now;
      Date.now = () => window.__qaDateNow() + 31_000;
    });
    await page.getByRole('button', { name: '刷新' }).click();
    await page.waitForTimeout(150);
    const staleStatus = await page.locator(`#execution-${bot.id}`).innerText();
    const staleCreateDisabled = await page.getByRole('button', { name: 'Host 创建' }).isDisabled();
    const staleEnableDisabled = await page.getByRole('button', { name: '启动 Host Session' }).isDisabled();
    lifecycle.staleObservation = { status: staleStatus, createDisabled: staleCreateDisabled, enableDisabled: staleEnableDisabled, method: 'page-local Date.now offset +31s; fixture/Host clock unchanged' };
    await page.evaluate(() => { if (window.__qaDateNow) Date.now = window.__qaDateNow; });
    await page.getByRole('button', { name: '刷新' }).click();
    await page.waitForTimeout(150);

    // Leave an explicit unconfirmed outcome as the final mutation so the
    // test cannot accidentally issue a new operation after uncertainty.
    await controls.getByRole('button', { name: '下一命令回报 unconfirmed' }).click();
    const unconfirmedConfigure = page.getByRole('button', { name: 'Host 配置' });
    if (await unconfirmedConfigure.isEnabled()) {
      await unconfirmedConfigure.click();
      hostDialog = page.getByRole('dialog');
      await hostDialog.getByLabel('模型配置引用').selectOption(model.id);
      await hostDialog.getByLabel('系统指令').fill('Unconfirmed outcome synthetic boundary');
      const beforeUnconfirmedPosts = executionRequests.length;
      await hostDialog.getByRole('button', { name: '排队 Host 配置' }).click();
      await page.locator('#pending:not([hidden])').waitFor({ timeout: 5000 });
      const unconfirmedId = (await page.locator('#pending-id').innerText()).trim();
      const queryReceipt = page.locator('#check-receipt');
      for (let i = 0; i < 5 && await page.locator('#pending').isVisible(); i++) {
        if (await queryReceipt.isVisible()) await queryReceipt.click();
        await page.waitForTimeout(350);
      }
      const beforeForbiddenNewRequest = executionRequests.length;
      await page.getByRole('button', { name: 'Host 配置' }).click().catch(() => {});
      lifecycle.unconfirmed = {
        mutationId: unconfirmedId,
        pendingRemains: await page.locator('#pending').isVisible(),
        sameMutationShown: (await page.locator('#pending-id').innerText()).trim() === unconfirmedId,
        newEditorBlocked: await page.getByRole('dialog').count() === 0,
        noNewExecutionRequest: executionRequests.length === beforeForbiddenNewRequest,
        submittedRequestObserved: executionRequests.length > beforeUnconfirmedPosts,
      };
    } else {
      lifecycle.unconfirmed = { skipped: 'Host configure was disabled after freshness/state recheck' };
    }
    await controls.close();
  }
  const authContext = await browser.newContext();
  const authPage = await authContext.newPage();
  let adminToken = '';
  let ordinaryDenied = null;
  authPage.on('request', request => {
    if (new URL(request.url()).pathname === '/api/admin/bootstrap') adminToken = (request.headers()['authorization'] || '').replace(/^Bearer\s+/i, '');
  });
  authPage.on('response', async response => {
    if (new URL(response.url()).pathname !== '/api/admin/bootstrap' || response.status() !== 403) return;
    try { ordinaryDenied = { http: 403, code: (await response.json()).error?.code || null }; } catch { ordinaryDenied = { http: 403, code: null }; }
  });
  await authPage.goto(`${base}/fixture-identity/admin`);
  const adminPopup = authPage.waitForEvent('popup');
  await authPage.getByRole('button', { name: '使用账号登录' }).click();
  await adminPopup;
  await authPage.waitForSelector('#console:not([hidden])', { timeout: 20000 });
  await authPage.waitForTimeout(150);
  const logoutResponse = authPage.waitForResponse(response => new URL(response.url()).pathname === '/auth/session' && response.request().method() === 'DELETE');
  await authPage.getByRole('button', { name: '退出' }).click();
  const logout = await logoutResponse;
  await authPage.waitForFunction(() => document.querySelector('#console')?.hidden);
  const revokedBootstrap = adminToken ? await authContext.request.get(`${base}/api/admin/bootstrap`, { headers: { authorization: `Bearer ${adminToken}` } }) : null;
  adminToken = '';
  await authPage.goto(`${base}/fixture-identity/ordinary`);
  const ordinaryPopup = authPage.waitForEvent('popup');
  await authPage.getByRole('button', { name: '使用账号登录' }).click();
  await ordinaryPopup;
  await authPage.waitForFunction(() => document.querySelector('#login')?.hidden === false && /平台管理权限/.test(document.querySelector('#login-status')?.textContent || ''), null, { timeout: 20000 });
  lifecycle.auth = {
    logoutHttp: logout.status(),
    revokedSessionBootstrapHttp: revokedBootstrap?.status() ?? null,
    ordinaryUser: ordinaryDenied,
    fixtureScope: 'isolated synthetic login only; bearer held in memory and omitted from output',
  };
  await authContext.close();

  console.log(JSON.stringify({
    status: 'synthetic_ui_observed',
    sourceHashes: expectedHashes,
    sanitizedBootstrap: safeBootstrap,
    bootstrapStatuses: apiResponses,
    viewports: widths,
    dialog: { initialFocus, invalidSubmitKeptDialog, requiredValidation: requiredValidation.match(/请输入[^\n]*/)?.[0] || null, escapeClosed },
    lifecycle,
    clientErrors,
    output,
    fixture: 'loopback-only synthetic identity; real AuthStore/DPoP/queue/signing; Host/SDK simulated',
  }, null, 2));
  if (widths.some(x => x.body > x.viewport + 1 || x.document > x.viewport + 1)) throw new Error('Horizontal overflow detected.');
  if (!invalidSubmitKeptDialog || !escapeClosed) throw new Error('Dialog validation or keyboard close failed.');
  if (lifecycle.staleObservation && (!lifecycle.staleObservation.status.includes('未知') || !lifecycle.staleObservation.createDisabled || !lifecycle.staleObservation.enableDisabled)) throw new Error('Stale observation did not fail closed.');
  if (lifecycle.unconfirmed && !lifecycle.unconfirmed.skipped && (!lifecycle.unconfirmed.pendingRemains || !lifecycle.unconfirmed.sameMutationShown || !lifecycle.unconfirmed.newEditorBlocked || !lifecycle.unconfirmed.noNewExecutionRequest || !lifecycle.unconfirmed.submittedRequestObserved)) throw new Error('Unconfirmed operation did not remain safely pending.');
  if (lifecycle.auth && (lifecycle.auth.logoutHttp < 200 || lifecycle.auth.logoutHttp >= 300 || lifecycle.auth.revokedSessionBootstrapHttp !== 401 || lifecycle.auth.ordinaryUser?.code !== 'ADMIN_REQUIRED')) throw new Error('Synthetic logout revocation or ordinary-user denial failed.');
} finally {
  await browser.close();
}
