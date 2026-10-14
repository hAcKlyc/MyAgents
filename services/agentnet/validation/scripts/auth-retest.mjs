import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const base=process.env.BOTS_ADMIN_FIXTURE_URL || 'http://127.0.0.1:5198';
if (!['127.0.0.1', 'localhost'].includes(new URL(base).hostname)) throw new Error('Only an isolated loopback fixture may be tested.');
const sourceHashes = Object.fromEntries(await Promise.all(['index.html','app.js','styles.css'].map(async name => [name, createHash('sha256').update(await readFile(new URL('../../admin-web/'+name,import.meta.url))).digest('hex')])));
const browser=await chromium.launch({headless:true, ...(process.env.CHROMIUM_EXECUTABLE ? { executablePath: process.env.CHROMIUM_EXECUTABLE } : {})});
const context=await browser.newContext();
const page=await context.newPage();
// Refuse evidence from an older fixture executable with different embedded assets.
for (const [name, expected] of Object.entries(sourceHashes)) {
 const response = await context.request.get(`${base}/${name === 'index.html' ? 'admin' : 'admin/' + name}`);
 const digest = createHash('sha256').update(await response.body()).digest('hex');
 if (response.status() !== 200 || digest !== expected) throw new Error(`Fixture asset does not match source: ${name}`);
}

let token='';
const forbidden=[];
page.on('response', async r=>{if(new URL(r.url()).pathname==='/api/admin/bootstrap'&&r.status()===403){let code='';try{code=(await r.json()).error?.code||''}catch { /* The HTTP status remains evidence if an error body is absent. */ } forbidden.push({http:r.status(),code})}});
page.on('request', req=>{if(req.url().includes('/api/admin/bootstrap')) token=(req.headers()['authorization']||'').replace(/^Bearer\s+/i,'');});
async function login(identity){
 await page.goto(`${base}/fixture-identity/${identity}`);
 await page.getByRole('button',{name:'使用账号登录'}).click();
 await page.waitForURL('**/fixture-login');
 await page.getByRole('link',{name:'返回后台'}).click();
 if(identity==='admin') await page.waitForSelector('#console:not([hidden])',{timeout:20000});
 else await page.waitForFunction(()=>document.querySelector('#login').hidden===false && /平台管理权限/.test(document.querySelector('#login-status').textContent),null,{timeout:20000});
}
const result={sourceHashes,fixture:'test-only loopback Rust AdminService/AuthStore; not production login'};
let popups = 0;
page.on('popup', () => popups++);
// Cancelling via browser Back clears tab state and does not accidentally consume a ready transaction.
await page.goto(`${base}/fixture-identity/admin`);
await page.getByRole('button',{name:'使用账号登录'}).click();
await page.waitForURL('**/fixture-login');
await page.goBack();
await page.waitForFunction(()=>/已取消/.test(document.querySelector('#login-status').textContent));
result.backCancellation = { cleared: await page.evaluate(()=>sessionStorage.length===0), retryEnabled: await page.getByRole('button',{name:'使用账号登录'}).isEnabled() };
await page.evaluate(()=>sessionStorage.setItem('moxbots.admin.pending-login.v1',JSON.stringify({tx:{transactionId:'expired',expiresAt:1},deviceId:'expired',verifier:'x'.repeat(43)})));
await page.goto(`${base}/admin?login=complete`);
await page.waitForFunction(()=>/已过期/.test(document.querySelector('#login-status').textContent));
result.expiry = { cleared: await page.evaluate(()=>sessionStorage.length===0), cleanUrl: page.url()===`${base}/admin` };

await login('admin');
await page.waitForTimeout(200);
if(!token) throw new Error('No in-memory bearer observed');
const delPromise=page.waitForResponse(r=>new URL(r.url()).pathname==='/auth/session'&&r.request().method()==='DELETE');
await page.getByRole('button',{name:'退出'}).click();
const del=await delPromise;
await page.waitForFunction(()=>document.querySelector('#console')?.hidden);
result.logout={http:del.status(),loginViewVisible:await page.locator('#login').isVisible(),pendingCleared:await page.evaluate(()=>sessionStorage.length===0)};
const revoked=await context.request.get(`${base}/api/admin/bootstrap`,{headers:{authorization:`Bearer ${token}`} });
result.revokedSessionBootstrap={http:revoked.status()};
token='';
await login('ordinary');
await page.waitForTimeout(300);
result.ordinaryUser={consoleHidden:await page.locator('#console').isHidden(),status:(await page.locator('#login-status').innerText()).trim(),bootstrap:forbidden.at(-1)};
result.popups = popups;
await browser.close();
console.log(JSON.stringify(result,null,2));
if(popups!==0||!result.backCancellation.cleared||!result.backCancellation.retryEnabled||!result.expiry.cleared||!result.expiry.cleanUrl||result.logout.http<200||result.logout.http>=300||result.revokedSessionBootstrap.http!==401||!result.ordinaryUser.consoleHidden||!result.ordinaryUser.status.includes('平台管理权限')||result.ordinaryUser.bootstrap?.code!=='ADMIN_REQUIRED') process.exitCode=1;
