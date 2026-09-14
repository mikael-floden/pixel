// THE ART QUEUE (client/src/artqueue.ts) DRAINING HEADLESS: a minute of running from
// spawn while sampling __ml.art() — queued, fetching, ready, landed, the biggest
// one-frame upload against the budget (KB=<n> env, default 128), parked monster
// kinds. Needs a built client. A frameKbMax far above the budget or failed > 0
// is the thing to look at.
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const port = 3300 + Math.floor(Math.random()*40); const origin = `http://127.0.0.1:${port}`;
const child = spawn(join(ROOT,"node_modules",".bin","tsx"),["src/index.ts"],{cwd:join(ROOT,"server"),detached:true,env:{...process.env,PORT:String(port),SERVE_CLIENT:"1",NODE_ENV:"production"},stdio:["ignore","ignore","ignore"]});
const stop=()=>{try{process.kill(-child.pid,"SIGKILL");}catch{}}; process.on("exit",stop);
for(let t0=Date.now();;){try{if((await fetch(origin+"/health")).ok)break;}catch{} if(Date.now()-t0>90000)throw new Error("unhealthy"); await new Promise(r=>setTimeout(r,250));}
const browser=await chromium.launch({executablePath:"/opt/pw-browsers/chromium-1194/chrome-linux/chrome",args:["--no-sandbox","--disable-dev-shm-usage"]});
const ctx=await browser.newContext({viewport:{width:484,height:630},deviceScaleFactor:2.23,serviceWorkers:"block"});
const page=await ctx.newPage();
const errs=[]; page.on("pageerror",(e)=>errs.push(e.message)); page.on("console",(m)=>{ if(m.type()==="error") errs.push("[console] "+m.text().slice(0,200)); });
await page.addInitScript((kb)=>{localStorage.setItem("ml-last-choice",JSON.stringify({world:"the_game",characterUid:"default_boy",name:"Q"}));sessionStorage.setItem("ml-rejoin","1");localStorage.setItem("ml-upload-kb", kb);}, process.env.KB||"128");
await page.goto(origin+"/",{waitUntil:"commit"});
await page.waitForFunction(()=>{try{return !!window.__ml&&window.__ml.players()>=1;}catch{return false;}},null,{timeout:180000,polling:100});
const sleep=(ms)=>new Promise(r=>setTimeout(r,ms));
let SEED=5; const rand=()=>((SEED=(SEED*1103515245+12345)&0x7fffffff)/0x7fffffff);
await page.evaluate(()=>window.__ml.perf(true));
const t0=Date.now(); let lastTap=0;
while (Date.now()-t0 < 60000) {
  if (Date.now()-lastTap > 6000) { lastTap=Date.now(); await page.evaluate(({a,d})=>{const m=window.__ml.me(); if(!m) return; const x=m.x+Math.cos(a)*d, y=m.y+Math.sin(a)*d; if(window.__ml.blockedAt(x,y)) return; const s=window.__ml.surfaceAt(x,y); if(!s||(!s.standable&&!s.swimmable)) return; window.__ml.tapTo(x,y,true);},{a:rand()*Math.PI*2,d:(10+rand()*12)*32}); }
  await sleep(5000);
  const r = await page.evaluate(()=>{ const s=window.__ml; const a=s.art(); const mb=s.monsterBoot(); const c=s.perf().counts; return { t:Math.round(performance.now()/1000), art:a, pendingKinds: mb.pending ? [...new Set(mb.pending)].length : -1, deferredKinds: mb.deferred ? mb.deferred.length : -1, monsters:c.monsters, textures:c.textures }; });
  console.log(`t+${r.t}s art: budget ${r.art.budgetKb} queued ${r.art.queued} fetching ${r.art.fetching} ready ${r.art.ready} (${r.art.readyKb} KB) landed ${r.art.landed} failed ${r.art.failed} frameKbMax ${Math.round(r.art.frameKbMax)} debt ${r.art.debtKb} | monsters ${r.monsters} parkedKinds ${r.pendingKinds} deferredKinds ${r.deferredKinds} textures ${r.textures}`);
}
const fin = await page.evaluate(()=>{ const p=window.__ml.perf(); const secs=Object.fromEntries(Object.entries(p.sections).filter(([k])=>/render|gapIdle|gapBusy|update/.test(k))); const anims=[]; for (const k of ["kick","die","hurt","punch","pickup"]) { const me=window.__ml.me && window.__ml.me(); anims.push(k); } return { frames:p.frames, secs, texFrameMax: p.counts.texFrameMax, texAdded: p.counts.texturesAdded }; });
console.log("frames", JSON.stringify(fin.frames), "texAdded", fin.texAdded, "texFrameMax", fin.texFrameMax, "errs", errs.slice(0,5));
await browser.close(); stop(); process.exit(0);
