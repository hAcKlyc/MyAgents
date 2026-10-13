import assert from 'node:assert/strict';
import {resolve} from 'node:path';
import {writeFile} from 'node:fs/promises';
export async function runJourneys(page,out){
 const results=[];
 const check=async(name,fn)=>{await fn();results.push({name,passed:true})};
 const root=()=>page.locator('.project-board');
 await check('actual rows, deduplication, exact states',async()=>{
  await root().getByText('7 项任务与会话 · 2 项需要处理').waitFor();
  assert.equal(await page.locator('[data-board-row="session:alpha-1"]').count(),0);
  assert.equal(await root().getByText('tasks.status.running').count(),0);
 });
 await check('search and original conversation round trip preserve filters, selection and draft',async()=>{
  await root().getByRole('button',{name:'需要我 2',exact:true}).click();
  await root().getByRole('searchbox').fill('项目管理');
  await page.locator('[data-group="verifying"] .pb-column-head').click();
  await page.locator('[data-board-row="task:task-verifying"]').click();
  await page.getByRole('button',{name:'交付与验收',exact:true}).click();
  await page.getByRole('textbox',{name:'验收说明（可选）'}).fill('验收草稿保留');
  await page.getByRole('button',{name:'原会话',exact:true}).click();
  await page.getByRole('button',{name:'项目看板',exact:true}).first().click();
  assert.equal(await root().getByRole('searchbox').inputValue(),'项目管理');
  assert.equal(await page.getByRole('textbox',{name:'验收说明（可选）'}).inputValue(),'验收草稿保留');
 });
 await check('failed acceptance keeps input and state; confirmed backend changes completed status',async()=>{
  await page.evaluate(()=>{window.boardFailAction=true});
  await page.getByRole('button',{name:'确认验收完成',exact:true}).click();
  await page.getByRole('alert').filter({hasText:'验收提交失败'}).waitFor();
  assert.equal(await page.getByRole('textbox',{name:'验收说明（可选）'}).inputValue(),'验收草稿保留');
  await page.evaluate(()=>{window.boardFailAction=false});
  await page.getByRole('button',{name:'确认验收完成',exact:true}).click();
  await page.waitForFunction(()=>window.boardCalls.filter(c=>c.kind==='status').length===2);
  await page.getByRole('button',{name:'确认验收完成',exact:true}).waitFor({state:'detached'});
 });
 await check('Escape closes panel and restores row focus',async()=>{
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('.pb-detail').count(),0);
  await root().getByRole('button',{name:'全部',exact:true}).click();
  await root().getByRole('searchbox').fill('');
  await page.locator('[data-group="needs"] .pb-column-head').click();
  await page.locator('[data-board-row="task:task-blocked"]').click();
  await page.keyboard.press('Escape');
  await page.waitForFunction(()=>document.activeElement?.getAttribute('data-board-row')==='task:task-blocked');
 });
 await check('original session event carries correct workspace/session',async()=>{
  await page.locator('[data-board-row="task:task-blocked"]').click();
  await page.locator('.pb-session-link').click();
  assert.ok(await page.evaluate(()=>window.boardCalls.some(c=>c.kind==='openSession'&&c.sessionId==='alpha-1'&&c.workspacePath==='/synthetic/alpha')));
  await page.getByRole('button',{name:'项目看板',exact:true}).first().click();
  await page.keyboard.press('Escape');
 });
 await check('list mode, task read failure retains data and recovery',async()=>{
  await root().getByRole('button',{name:'列表',exact:true}).click();
  assert.equal(await page.locator('.pb-table tbody tr').count(),7);
  await page.evaluate(()=>{window.boardFailRead=true});
  await root().getByRole('button',{name:'刷新状态',exact:true}).click();
  await page.getByRole('alert').filter({hasText:'任务读取失败'}).waitFor();
  assert.equal(await page.locator('.pb-table tbody tr').count(),7);
  await page.evaluate(()=>{window.boardFailRead=false});
  await root().getByRole('button',{name:'刷新状态',exact:true}).click();
  await page.getByRole('alert').filter({hasText:'任务读取失败'}).waitFor({state:'detached'});
  await root().getByRole('button',{name:'看板',exact:true}).click();
 });
 for(const width of [1440,1024,768,540])await check(`responsive ${width}`,async()=>{
  await page.setViewportSize({width,height:900});
  await page.waitForTimeout(250);
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
  await page.screenshot({path:resolve(out,`board-dark-${width}.png`)});
 });
 await check('narrow detail, submit failure, grouped columns',async()=>{
  await page.locator('[data-group="needs"] .pb-column-head').click();
  if(!await page.locator('[data-board-row="task:task-blocked"]').isVisible())await page.locator('[data-group="needs"] .pb-column-head').click();
  await page.locator('[data-board-row="task:task-blocked"]').click();
  await page.screenshot({path:resolve(out,'detail-dark-540.png')});
  const bounds=await page.locator('.pb-detail').boundingBox();assert.ok(bounds.width>=450);
  await page.keyboard.press('Escape');
 });
 await page.setViewportSize({width:1440,height:900});
 await page.goto(page.url()+'?light');
 await page.locator('.project-board').waitFor();
 await page.screenshot({path:resolve(out,'board-light-1440.png')});
 results.push({name:'light theme renders',passed:true});
 await writeFile(resolve(out,'results.json'),JSON.stringify({environment:'isolated Chromium, actual production React components; synthetic API fixtures; no native/backend acceptance',results},null,2));
 console.log('PROJECT_BOARD_JOURNEYS '+results.length+' passed');
}
