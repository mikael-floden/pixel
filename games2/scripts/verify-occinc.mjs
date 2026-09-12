// THE INCREMENTAL OCCLUDER REBUILD, checked against a full walk (docs/perf.md, THE
// WALK IS INCREMENTAL TOO): run trips from spawn with the incremental path on,
// after each trip compare the live set with a fresh full walk at the same camera
// (`__ml.occIncCheck`), then the same trips with it off for the cost of the walk.
// Needs a built client (`npm run build -w client`). Exit 1 on any missing image or
// record.
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
const ctx=await browser.newContext({viewport:{width:412,height:732},serviceWorkers:"block"});
const page=await ctx.newPage();
page.on("pageerror",(e)=>console.log("[pageerror]",e.message));
await page.addInitScript(()=>{localStorage.setItem("ml-last-choice",JSON.stringify({world:"the_game",characterUid:"default_boy",name:"Bench"}));sessionStorage.setItem("ml-rejoin","1");});
await page.goto(origin+"/",{waitUntil:"commit"});
await page.waitForFunction(()=>{try{return !!window.__ml&&window.__ml.players()>=1;}catch{return false;}},null,{timeout:180000,polling:100});
const sleep=(ms)=>new Promise(r=>setTimeout(r,ms));
let SEED = 7; const rand=()=>((SEED=(SEED*1103515245+12345)&0x7fffffff)/0x7fffffff);
let fail = 0;
const boot = async () => {
  await page.goto(origin+"/",{waitUntil:"commit"});
  await page.waitForFunction(()=>{try{return !!window.__ml&&window.__ml.players()>=1;}catch{return false;}},null,{timeout:180000,polling:100});
  await sleep(6000);
};
for (const on of [true,false]) {
  SEED = 7;
  if (!on) await boot();
  await page.evaluate((on)=>{window.__ml.occInc(on); window.__ml.perf(true);},on);
  for (let trip=0; trip<10; trip++) {
    const t = await page.evaluate(({a,d,run})=>{const m=window.__ml.me(); if(!m) return null; const x=m.x+Math.cos(a)*d, y=m.y+Math.sin(a)*d; if(window.__ml.blockedAt(x,y)) return null; const s=window.__ml.surfaceAt(x,y); if(!s||(!s.standable&&!s.swimmable)) return null; window.__ml.tapTo(x,y,run); return !!window.__ml.target();},{a:rand()*Math.PI*2,d:(12+rand()*14)*32,run:true});
    if (!t) continue;
    for (let i=0;i<40;i++){ await sleep(200); if(!(await page.evaluate(()=>!!window.__ml.target()))) break; }
    const chk = await page.evaluate(()=>{ const s=window.__ml.occInc(); const c=window.__ml.occIncCheck(); const m=window.__ml.me(); return {s,c,me:m?[Math.round(m.x),Math.round(m.y)]:null}; });
    // Sprites and records, not the depth slot (see occIncCheck's contract).
    const bad = chk.c.missingSprites || chk.c.extraInView || chk.c.missingMeta || chk.c.extraMeta;
    if (bad) fail++;
    console.log(`${on?"INC ":"FULL"} trip ${trip} @${chk.me}: steps ${chk.s.steps} walked ${chk.s.walked} of ${chk.s.cells} cells (partial ${chk.s.partial} incomplete ${chk.s.incomplete}) | inc ${chk.c.inc} full ${chk.c.full} missingSprites ${chk.c.missingSprites} extraInView ${chk.c.extraInView} (slot-only ${chk.c.missingImgs}) missingMeta ${chk.c.missingMeta} extraMeta ${chk.c.extraMeta} ${bad?"  <-- DIFF "+JSON.stringify([chk.c.sampleMissingSprites,chk.c.sampleExtraSprites,chk.c.sampleMissingMeta]).slice(0,500):""}`);
  }
  const p = await page.evaluate(()=>window.__ml.perf());
  const ro = p.sections.rebuildOccluders || {n:0,totalMs:0,avgMs:0,maxMs:0};
  console.log(`${on?"INC ":"FULL"}: rebuildOccluders n ${ro.n} total ${ro.totalMs} avg ${ro.avgMs} max ${ro.maxMs} | frames p90 ${p.frames.p90} p99 ${p.frames.p99} max ${p.frames.max}`);
  for (const k of ["occWalkFull","occWalkInc","rebuildScenery","coverIndex","repaintCells","render","update"]) if (p.sections[k]) console.log(`      ${k.padEnd(15)} ${JSON.stringify(p.sections[k])}`);
}
console.log(fail ? `PARITY FAILED (${fail} checks)` : "PARITY OK");
await browser.close(); stop(); process.exit(fail?1:0);
