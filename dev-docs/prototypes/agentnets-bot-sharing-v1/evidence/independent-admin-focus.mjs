import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const playwrightLocation = process.env.PLAYWRIGHT_MODULE || '/Users/zhangshaohua/Documents/Codex/2026-10-12/myagents-selfhost-service/node_modules/playwright';
const playwrightEntry = playwrightLocation.endsWith('.mjs') ? playwrightLocation : path.join(playwrightLocation, 'index.mjs');
const { chromium } = await import(pathToFileURL(playwrightEntry).href);

(async()=>{const b=await chromium.launch({headless:true,executablePath:process.env.CHROMIUM_EXECUTABLE||'/Users/zhangshaohua/Library/Caches/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-mac-arm64/chrome-headless-shell'});const p=await b.newPage({viewport:{width:1440,height:900}});await p.goto((process.env.PROTOTYPE_URL||'http://127.0.0.1:5197/'));await p.locator('[data-a="open-user"]').click();await p.keyboard.press('Tab');const focused=await p.evaluate(()=>({text:document.activeElement.textContent,action:document.activeElement.dataset.a,inUserView:!!document.activeElement.closest('.usersim'),hit:document.elementFromPoint(document.activeElement.getBoundingClientRect().x+3,document.activeElement.getBoundingClientRect().y+3)?.textContent}));fs.writeFileSync(path.join(scriptDir,'independent-admin-focus.json'),JSON.stringify(focused,null,2));console.log(focused);await b.close()})()
