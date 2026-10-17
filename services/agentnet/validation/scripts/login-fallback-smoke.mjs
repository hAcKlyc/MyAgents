import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const base = process.env.BOTS_ADMIN_FIXTURE_URL || 'http://127.0.0.1:5198';
if (!['127.0.0.1', 'localhost'].includes(new URL(base).hostname)) throw new Error('Only an isolated loopback fixture may be tested.');
const sourceHashes = Object.fromEntries(await Promise.all(['index.html','app.js','styles.css'].map(async name =>
  [name, createHash('sha256').update(await readFile(new URL('../../admin-web/' + name, import.meta.url))).digest('hex')])));
const browser = await chromium.launch({headless:true, ...(process.env.CHROMIUM_EXECUTABLE ? {executablePath:process.env.CHROMIUM_EXECUTABLE} : {})});
const context = await browser.newContext();
const page = await context.newPage();
const evidenceDir = process.env.BOTS_ADMIN_QA_OUTPUT || await mkdtemp(join(tmpdir(), 'bots-admin-login-fallback-'));
await mkdir(evidenceDir,{recursive:true});
for (const [name, expected] of Object.entries(sourceHashes)) {
  const response = await context.request.get(`${base}/${name === 'index.html' ? 'admin' : 'admin/' + name}`);
  const digest = createHash('sha256').update(await response.body()).digest('hex');
  if (response.status() !== 200 || digest !== expected) throw new Error(`Fixture asset does not match source: ${name}`);
}
let bearer = '';
page.on('request', request => {
  if (new URL(request.url()).pathname === '/api/admin/bootstrap') bearer = (request.headers().authorization || '').replace(/^Bearer\s+/i, '');
});
await page.addInitScript(() => {
  window.__fakePopup = {closed:false, location:{set href(value){window.__popupAssignedOrigin=new URL(value).origin;}}, close(){this.closed=true;}};
  window.open = () => window.__fakePopup;
});
await page.goto(`${base}/fixture-identity/admin`);
const loginViewports=[];
for(const [width,height] of [[390,844],[768,1024]]) {
  await page.setViewportSize({width,height});
  await page.screenshot({path:join(evidenceDir,`login-fallback-${width}x${height}.png`),fullPage:true});
  loginViewports.push(await page.evaluate(()=>({viewport:innerWidth,documentWidth:document.documentElement.scrollWidth,bodyWidth:document.body.scrollWidth})));
  await page.keyboard.press('Tab');
  const focus=await page.evaluate(()=>({id:document.activeElement?.id,outline:getComputedStyle(document.activeElement).outlineStyle,width:getComputedStyle(document.activeElement).outlineWidth}));
  if(focus.id!=='login-button'||focus.outline==='none'||parseFloat(focus.width)<1) throw new Error(`Login button focus treatment missing at ${width}px.`);
  await page.keyboard.press('Shift+Tab');
}
if(loginViewports.some(view=>view.documentWidth>view.viewport||view.bodyWidth>view.viewport)) throw new Error('Login view overflows a tested viewport.');
await page.setViewportSize({width:1440,height:900});
let heldPoll;
let sawPoll;
const pollStarted = new Promise(resolve => { sawPoll = resolve; });
await page.route('**/auth/login/poll', async route => { heldPoll = route; sawPoll(); });
const authLink = page.locator('#auth-link');
await page.getByRole('button', {name:'使用账号登录'}).click();
await authLink.waitFor({state:'visible'});
const loginUrl = new URL(await authLink.getAttribute('href'));
if (loginUrl.origin !== new URL(base).origin || loginUrl.pathname !== '/fixture-login' || loginUrl.username || loginUrl.password) {
  throw new Error('Fallback link does not point to the validated local fixture authorization URL.');
}
if (await page.evaluate(() => window.__popupAssignedOrigin) !== loginUrl.origin) throw new Error('The non-null popup path was not assigned the validated URL.');
const fallbackViewports=[];
for(const [width,height] of [[390,844],[768,1024]]) {
  await page.setViewportSize({width,height});
  fallbackViewports.push(await page.evaluate(()=>({viewport:innerWidth,documentWidth:document.documentElement.scrollWidth,bodyWidth:document.body.scrollWidth})));
  await page.evaluate(()=>document.activeElement?.blur());
  await page.keyboard.press('Tab');
  if(await page.evaluate(()=>document.activeElement?.id)==='cancel-login') await page.keyboard.press('Shift+Tab');
  const focus=await authLink.evaluate(element=>({active:document.activeElement===element,outline:getComputedStyle(element).outlineStyle,width:getComputedStyle(element).outlineWidth}));
  if(!focus.active||focus.outline==='none'||parseFloat(focus.width)<1) throw new Error(`Fallback link focus treatment missing at ${width}px.`);
  await page.screenshot({path:join(evidenceDir,`login-fallback-active-${width}x${height}.png`),fullPage:true});
}
if(fallbackViewports.some(view=>view.documentWidth>view.viewport||view.bodyWidth>view.viewport)) throw new Error('Active login view overflows a tested viewport.');
await page.setViewportSize({width:1440,height:900});
const [loginTab] = await Promise.all([context.waitForEvent('page'), authLink.click()]);
await loginTab.waitForURL(value=>new URL(value).pathname==='/fixture-login');
await pollStarted;
await heldPoll.continue();
await page.waitForSelector('#console:not([hidden])', {timeout:10000});
if (!bearer) throw new Error('Fallback login did not complete through the real fixture poll route.');
if (!(await authLink.evaluate(element => element.hidden)) || await authLink.getAttribute('href') !== null) throw new Error('Successful login retained the authorization link.');
if (!(await page.locator('#cancel-login').evaluate(element => element.hidden))) throw new Error('Successful login retained the cancel control.');
await loginTab.close();
await page.getByRole('button', {name:'退出'}).click();
await page.waitForSelector('#login:not([hidden])');

let cancelPoll;
let cancelPollRoute;
const cancelPollStarted = new Promise(resolve => { cancelPoll = resolve; });
await page.route('**/auth/login/cancel', route => route.fulfill({status:204,body:''}));
await page.evaluate(() => { window.open = () => null; });
await page.route('**/auth/login/poll', async route => { cancelPollRoute = route; cancelPoll(); });
await page.getByRole('button', {name:'使用账号登录'}).click();
await page.locator('#auth-link').waitFor({state:'visible'});
const cancelDelete = page.waitForRequest(request => new URL(request.url()).pathname === '/auth/login/cancel' && request.method() === 'DELETE');
await cancelPollStarted;
await page.getByRole('button', {name:'取消登录'}).click();
await cancelDelete;
if (!(await authLink.evaluate(element => element.hidden)) || await authLink.getAttribute('href') !== null) throw new Error('Cancel retained the authorization link.');
await cancelPollRoute?.abort().catch(() => {});
await page.unroute('**/auth/login/poll');
await page.getByRole('button', {name:'使用账号登录'}).click();
await page.waitForSelector('#console:not([hidden])', {timeout:10000});
if (!(await authLink.evaluate(element => element.hidden)) || await authLink.getAttribute('href') !== null) throw new Error('A new login inherited a stale authorization link.');
await browser.close();
console.log(JSON.stringify({sourceHashes, popupReturnedNonNullButNoPopupExposed:true, fallbackPath:'/fixture-login', fallbackSucceeded:true,
  cancelRemovedLink:true, subsequentLoginSucceeded:true, loginViewports, fallbackViewports, loginFocusPass:true, fallbackLinkFocusPass:true, screenshots:evidenceDir, reportContainsBearer:false,
  fixture:'test-only loopback Rust AdminService/AuthStore; synthetic identity, not production OIDC'}));
