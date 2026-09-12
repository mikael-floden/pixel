// THE COMPOSE WORKER'S GATE (docs/perf.md): walk a fresh stretch headless with the
// worker on and its audit on — every raster the worker lands is composed again on
// the frame thread and compared byte for byte (audit.diff must be 0) — then the
// same stretch with the worker off, printing the ground sections per frame for
// both (headless timing is only relative). Needs a built client. Exit 1 on any
// audit difference or a worker that never became ready.
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
const START=(process.env.AT||"441,364").split(",").map(Number); // the spawn: 128-287 compositions a window
const legs=[[10,0],[0,10],[-10,0],[0,-10],[12,6],[-12,-6]];
let failed=false;
const run = async (on) => {
  const ctx=await browser.newContext({viewport:{width:484,height:630},deviceScaleFactor:1,serviceWorkers:"block"});
  const page=await ctx.newPage(); const errs=[]; page.on("pageerror",(e)=>errs.push(e.message));
  await page.addInitScript((on)=>{localStorage.setItem("ml-last-choice",JSON.stringify({world:"the_game",characterUid:"default_boy",name:"W"}));sessionStorage.setItem("ml-rejoin","1");localStorage.setItem("ml-compose-worker", on?"1":"0");}, on);
  await page.goto(origin+"/",{waitUntil:"commit"});
  await page.waitForFunction(()=>{try{return !!window.__ml&&window.__ml.players()>=1;}catch{return false;}},null,{timeout:180000,polling:100});
  // The audit goes on BEFORE the teleport, so the fresh window's every
  // composition (128-287 around the spawn) is composed twice and compared.
  const boot=await page.evaluate(()=>window.__ml.composeWorker({audit:true}));
  await page.evaluate(([c,r])=>window.__ml.teleport(c,r),START); await sleep(10000);
  await page.evaluate(()=>window.__ml.composeWorker({audit:true}));
  await page.evaluate(()=>window.__ml.perf(true));
  let at=[...START];
  for (const [dc,dr] of legs) {
    at=[at[0]+dc, at[1]+dr];
    await page.evaluate(([c,r])=>{ const p=window.__ml.cellToWorld? window.__ml.cellToWorld(c,r):null; if(p) window.__ml.tapTo(p.x,p.y,true); else window.__ml.teleport(c,r); },at);
    for (let i=0;i<30;i++){ await sleep(500); const t=await page.evaluate(()=>!!window.__ml.target()); if(!t) break; }
  }
  await sleep(3000);
  const st=await page.evaluate(()=>window.__ml.composeWorker());
  const p=await page.evaluate(()=>window.__ml.perf());
  const g=await page.evaluate(()=>{ const s=window.__ml.groundScroll(); return s && s.drain ? s.drain : null; });
  await ctx.close();
  const n=p.frames.n; const pf=(k)=>p.sections[k]?(p.sections[k].totalMs/n).toFixed(2):"-";
  console.log(`${on?"WORKER ON ":"WORKER OFF"} frames ${n} | per frame: prefetch ${pf("prefetch")} landRepaint ${pf("landRepaint")} repaintCells ${pf("repaintCells")} groundSlice ${pf("groundSlice")} redrawGround ${pf("redrawGround")} render ${pf("render")} | state ${st.state} boot ${st.bootMs}ms queued ${st.queued} landed ${st.landed} missed ${st.missed} inflight ${st.inflight} workerMs ${Math.round(st.workerMs)} applyMs ${st.applyMs.toFixed(1)} batches ${st.batches} | audit same ${st.audit.same} diff ${st.audit.diff} ${st.audit.diff?JSON.stringify(st.audit.sample):""} | owed ${g?`b${g.bOwed} d${g.dOwed} deferred ${g.bDeferred} builtB ${g.builtB}`:"-"} | errs ${JSON.stringify(errs.slice(0,2))}`);
  if (on && (st.state!=="ready" || st.audit.diff>0 || boot.enabled!==true)) failed=true;
};
await run(true); await run(false);
await browser.close(); stop(); process.exit(failed?1:0);
