// THE PROXIMITY CULL'S GATE (docs/depth-sort.md): walk ten legs headless with the
// cull on, audit after each leg (`__ml.occNear()`: every hidden in-view occluder
// against every drawn body's real bounds — wrongHidden must be 0), then the same
// legs with it off as the A/B. Prints per-frame section means (headless timing is
// only relative). Needs a built client. Exit 1 on any wrongHidden.
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
const sleep=(ms)=>new Promise(r=>setTimeout(r,ms));
const START=(process.env.AT||"236,206").split(",").map(Number);
const legs=[[8,3],[0,6],[-8,3],[0,-6],[8,-3],[0,-6],[6,4],[-6,4],[-6,-4],[6,-4]];
let failed = false;
const run = async (on) => {
  const ctx=await browser.newContext({viewport:{width:484,height:630},deviceScaleFactor:1,serviceWorkers:"block"});
  const page=await ctx.newPage(); const errs=[]; page.on("pageerror",(e)=>errs.push(e.message));
  await page.addInitScript(()=>{localStorage.setItem("ml-last-choice",JSON.stringify({world:"the_game",characterUid:"default_boy",name:"B"}));sessionStorage.setItem("ml-rejoin","1");});
  await page.goto(origin+"/",{waitUntil:"commit"});
  await page.waitForFunction(()=>{try{return !!window.__ml&&window.__ml.players()>=1;}catch{return false;}},null,{timeout:180000,polling:100});
  await page.evaluate(([c,r])=>window.__ml.teleport(c,r),START); await sleep(12000);
  await page.evaluate((on)=>{ window.__ml.occNear(on); window.__ml.perf(true); }, on);
  const audits=[]; let at=[...START];
  for (const [dc,dr] of legs) {
    at=[at[0]+dc, at[1]+dr];
    await page.evaluate(([c,r])=>{ const p=window.__ml.cellToWorld? window.__ml.cellToWorld(c,r):null; if(p) window.__ml.tapTo(p.x,p.y,true); else window.__ml.teleport(c,r); },at);
    for (let i=0;i<24;i++){ await sleep(500); const t=await page.evaluate(()=>!!window.__ml.target()); if(!t) break; }
    audits.push(await page.evaluate(()=>window.__ml.occNear()));
  }
  const p=await page.evaluate(()=>window.__ml.perf());
  await ctx.close();
  if (on && audits.some((a)=>a.wrongHidden>0)) failed = true;
  const n=p.frames.n; const pf=(k)=>p.sections[k]?(p.sections[k].totalMs/n).toFixed(2):"-";
  console.log(`${on?"NEAR ON ":"NEAR OFF"} frames ${n} p50 ${p.frames.p50} p90 ${p.frames.p90} | per frame: render ${pf("render")} depthSort ${pf("depthSort")} occCull ${pf("occCull")} occNear ${pf("occNear")} gapBusy ${pf("gapBusy")} rebuildOccluders ${pf("rebuildOccluders")} | dl ${p.counts.displayList} occ ${p.counts.occluders} shown ${p.counts.occShown} errs ${JSON.stringify(errs.slice(0,2))}`);
  console.log("   audits:", JSON.stringify(audits));
};
await run(true); await run(false);
await browser.close(); stop(); process.exit(failed ? 1 : 0);
