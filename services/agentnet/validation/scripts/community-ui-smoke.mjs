/* Synthetic loopback acceptance. Start the ignored community_browser_fixture first. */
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const base = process.env.COMMUNITY_FIXTURE_URL || 'http://127.0.0.1:5198';
if (!['127.0.0.1', 'localhost'].includes(new URL(base).hostname)) throw new Error('Loopback fixture required.');
const out = process.env.COMMUNITY_QA_OUTPUT || await mkdtemp(join(tmpdir(), 'moxbots-community-ui-'));
const browser = await chromium.launch({ headless: true, ...(process.env.CHROMIUM_EXECUTABLE ? { executablePath: process.env.CHROMIUM_EXECUTABLE } : {}) });
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await context.newPage();
const clientErrors = [], mutations = [];
const topicTitle = `社区验收 ${Date.now()} <script>alert(1)</script>`;
page.on('pageerror', e => clientErrors.push(e.message));
page.on('request', r => { if (/\/api\/(?:admin\/)?community/.test(r.url()) && ['POST', 'PATCH'].includes(r.method())) mutations.push({ method: r.method(), path: new URL(r.url()).pathname, body: r.postDataJSON() }); });
const checks = [];
const checked = text => { checks.push(text); process.stdout.write(`PASS ${text}\n`); };
const shot = async name => page.screenshot({ path: join(out, name), fullPage: true });
const login = async (identity, admin = false) => {
  await page.locator('#login-button').click();
  await page.getByRole('link', { name: identity, exact: true }).click();
  await page.locator(admin ? '#console' : '#workspace').waitFor({ state: 'visible' });
};
const expire = async () => {
  await page.route('**/api/community', async route => { if (route.request().method() === 'GET') { await route.fulfill({ status: 401, contentType: 'application/json', body: JSON.stringify({ ok: false, error: { code: 'UNAUTHORIZED' } }) }); await page.unroute('**/api/community'); } else await route.continue(); });
  await page.locator('#refresh').click(); await page.locator('#login').waitFor({ state: 'visible' });
};
const noOverflow = async () => assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'page horizontal overflow');
try {
  for (const surface of ['community', 'admin']) for (const name of ['index.html', 'app.js', 'styles.css']) {
    const source = await readFile(new URL(`../../${surface}-web/${name}`, import.meta.url));
    const response = await context.request.get(`${base}/${surface}${name === 'index.html' ? '' : '/' + name}`);
    assert.equal(response.status(), 200); assert.equal(createHash('sha256').update(await response.body()).digest('hex'), createHash('sha256').update(source).digest('hex'), `${surface}/${name} asset source mismatch`);
  }
  checked('fixture embeds exact current source assets');
  await page.goto(base + '/community');
  assert(await page.locator('#workspace').isHidden()); await shot('community-login-1440.png');
  await login('普通用户'); await page.waitForFunction(() => document.getElementById('topic-count').textContent.includes('个话题'));
  checked('explicit same-tab PKCE login and auth-gated content');
  await page.locator('#new-topic').click();
  await page.locator('#topic-form [name=title]').fill(topicTitle);
  await page.locator('#topic-form [name=content]').fill('Bot 团队协作实践\n<img src=x onerror=alert(1)>\n一次完整的讨论与回复。');
  await page.keyboard.press('Escape');
  assert(await page.locator('#new-topic').evaluate(n => n === document.activeElement));
  await page.locator('#new-topic').click();
  assert.equal(await page.locator('#topic-form [name=content]').inputValue(), 'Bot 团队协作实践\n<img src=x onerror=alert(1)>\n一次完整的讨论与回复。');
  await page.locator('#submit-topic').click();
  await page.locator('#detail-title').filter({ hasText: topicTitle }).waitFor();
  await page.locator('#reply-section').waitFor({ state: 'visible' });
  assert.equal(await page.locator('#detail-body img,#detail-body script').count(), 0);
  checked('topic create, safe literal content, Escape/focus return and draft retention');
  await page.locator('#reply-form textarea').fill('回复草稿保留验证');
  await page.keyboard.press('Escape');
  await page.locator('.topic-card').filter({ hasText: topicTitle }).click();
  await page.locator('#reply-section').waitFor({ state: 'visible' });
  assert.equal(await page.locator('#reply-form textarea').inputValue(), '回复草稿保留验证');
  // Commit upstream, then drop the response. Retry must use the same ID and body.
  let replyAttempts = 0;
  const replyRoute = async route => {
    if (route.request().method() === 'POST' && ++replyAttempts === 1) { await route.fetch(); await route.abort('failed'); }
    else if (replyAttempts === 2 && route.request().method() === 'POST') await route.fulfill({ status: 401, contentType: 'application/json', body: JSON.stringify({ ok: false, error: { code: 'UNAUTHORIZED' } }) });
    else await route.continue();
  };
  await page.route('**/api/community/*/replies', replyRoute);
  await page.locator('#submit-reply').click();
  await page.locator('#reply-status').filter({ hasText: '发布结果尚未确认' }).waitFor();
  await page.locator('#submit-reply').click(); await page.locator('#login').waitFor({ state: 'visible' });
  const beforeRelogin = mutations.length;
  await login('普通用户');
  assert.equal(mutations.length, beforeRelogin, 'draft must never auto-submit after login');
  await page.locator('.topic-card').filter({ hasText: topicTitle }).click();
  await page.locator('#submit-reply').filter({ hasText: '重试原回复' }).waitFor();
  assert(await page.locator('#reply-form textarea').isDisabled());
  await page.locator('#submit-reply').click();
  await page.waitForFunction(() => document.getElementById('reply-status').textContent === '');
  await page.locator('.reply-card').filter({ hasText: '回复草稿保留验证' }).waitFor();
  assert.equal(await page.locator('.reply-card').filter({ hasText: '回复草稿保留验证' }).count(), 1);
  const replyPosts = mutations.filter(m => m.path.endsWith('/replies'));
  assert.equal(replyPosts.length, 3); assert.deepEqual(replyPosts[0].body, replyPosts[1].body); assert.deepEqual(replyPosts[0].body, replyPosts[2].body);
  await page.unroute('**/api/community/*/replies', replyRoute);
  checked('uncertain committed reply survives same-principal re-login and retries exactly once without duplication');
  await page.keyboard.press('Escape');
  await page.locator('#categories button[data-category=showcase]').click();
  await page.getByText('没有找到相关话题', { exact: true }).waitFor();
  await page.locator('#categories button[data-category=all]').click();
  await page.locator('#search').fill('不存在的关键词');
  await page.getByText('没有找到相关话题', { exact: true }).waitFor(); await page.locator('#search').fill('');
  await page.route('**/api/community', async route => { await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ ok: false, error: { code: 'COMMUNITY_UNAVAILABLE' } }) }); await page.unroute('**/api/community'); });
  await page.locator('#refresh').click(); await page.locator('#retry-list').waitFor({ state: 'visible' }); await page.locator('#retry-list').click(); await page.locator('#retry-list').waitFor({ state: 'hidden' });
  checked('category/search empty states and service failure/retry');
  for (const [width, height] of [[1440,900], [768,1024], [390,844]]) {
    await page.setViewportSize({ width, height }); await noOverflow(); await shot(`community-list-${width}.png`);
    await page.locator('.topic-card').first().click(); await page.locator('#reply-section').waitFor({ state: 'visible' }); await noOverflow(); await shot(`community-detail-${width}.png`); await page.keyboard.press('Escape');
  }
  checked('community list/detail 1440, 768 and 390 responsive geometry');
  await page.locator('#new-topic').click(); await page.locator('#topic-form [name=title]').fill('仅属于原账号的草稿'); await page.locator('#topic-form [name=content]').fill('不同主体不得恢复此内容'); await page.keyboard.press('Escape');
  await expire(); await login('另一用户'); await page.locator('#new-topic').click(); assert.equal(await page.locator('#topic-form [name=title]').inputValue(), ''); assert.equal(await page.locator('#topic-form [name=content]').inputValue(), ''); await page.keyboard.press('Escape');
  const stored = await page.evaluate(() => ({ local: { ...localStorage }, session: { ...sessionStorage } }));
  assert.equal(JSON.stringify(stored).includes('accessToken'), false); assert.equal(JSON.stringify(stored).includes('Bearer '), false); assert.equal(stored.session['moxbots.community.pending-login.v1'], undefined);
  await page.locator('#logout').click(); await page.locator('#login').waitFor({ state: 'visible' });
  checked('different-principal draft isolation, token-free storage and logout');
  await page.goto(base + '/admin'); await login('管理员', true); await page.locator('[data-page=community]').click(); await page.locator('.community-admin-row').filter({ hasText: topicTitle }).waitFor();
  await page.locator('.community-admin-row').filter({ hasText: topicTitle }).click(); await page.locator('.community-moderation').waitFor();
  assert.equal(await page.locator('.community-admin-detail img,.community-admin-detail script').count(), 0);
  await page.getByLabel('置顶话题', { exact: true }).check(); await page.getByLabel('锁定讨论（暂停新回复）', { exact: true }).check();
  await page.getByRole('button', { name: '保存社区设置', exact: true }).click(); await page.locator('.community-moderation').waitFor();
  await page.locator('.community-admin-detail .community-tags').getByText('置顶', { exact: true }).waitFor();
  assert(await page.getByLabel('锁定讨论（暂停新回复）', { exact: true }).isChecked());
  checked('existing admin session/navigation, topic/replies and CAS pin/lock moderation');
  const patchRoute = async route => { await route.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({ ok: false, error: { code: 'REVISION_CONFLICT' } }) }); await page.unroute('**/api/admin/community/*', patchRoute); };
  await page.route('**/api/admin/community/*', patchRoute); await page.getByLabel('隐藏话题（普通用户不可见）', { exact: true }).check(); await page.getByRole('button', { name: '保存社区设置', exact: true }).click();
  await page.getByRole('button', { name: '重新加载最新话题', exact: true }).click(); await page.locator('.community-moderation').waitFor(); assert.equal(await page.getByLabel('隐藏话题（普通用户不可见）', { exact: true }).isChecked(), false);
  checked('admin revision conflict requires explicit reload');
  let patchDropped = false;
  const uncertainPatch = async route => { if (!patchDropped && route.request().method() === 'PATCH') { patchDropped = true; await route.fetch(); await route.abort('failed'); } else await route.continue(); };
  await page.route('**/api/admin/community/*', uncertainPatch);
  await page.getByLabel('隐藏话题（普通用户不可见）', { exact: true }).check(); await page.getByRole('button', { name: '保存社区设置', exact: true }).click(); await page.getByRole('button', { name: '重试原社区操作', exact: true }).waitFor();
  await page.locator('[data-page=bots]').click(); await page.locator('[data-page=community]').click(); await page.getByRole('button', { name: '重试原社区操作', exact: true }).click();
  await page.locator('.community-admin-detail .community-tags').getByText('已隐藏', { exact: true }).waitFor();
  const patches = mutations.filter(m => m.method === 'PATCH'); assert.deepEqual(patches.at(-1).body, patches.at(-2).body);
  await page.unroute('**/api/admin/community/*', uncertainPatch);
  checked('admin uncertain committed moderation survives section navigation and retries exact CAS request');
  for (const [width,height] of [[1440,900],[768,1024],[390,844]]) { await page.setViewportSize({width,height}); await noOverflow(); await shot(`admin-community-${width}.png`); }
  await page.locator('[data-page=bots]').click(); assert.equal(await page.locator('#page-title').textContent(), 'Bots 管理'); await page.locator('[data-page=community]').click(); await page.locator('.community-admin-detail').waitFor();
  checked('hidden moderation, existing Bots navigation and admin responsive geometry');
  assert.equal(clientErrors.length, 0, JSON.stringify(clientErrors));
  await writeFile(join(out, 'result.json'), JSON.stringify({ checks, clientErrors, mutations: mutations.map(m => ({ path: m.path, method: m.method, mutation_id: m.body.mutation_id, expected_revision: m.body.expected_revision })) }, null, 2));
  process.stdout.write(`Evidence: ${out}\n`);
} finally { await browser.close(); }
