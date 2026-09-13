// THE COVER ATLASES' PASS SHAPE (docs/perf.md, THE COVER ATLASES ARE ONE BRACKET EACH, ON
// THE ROWS IN USE), headless: run from the maintainer's route until bodies are covered, then
// (1) every flush ran the three-bracket path on a capture no taller than the atlas, (2) the
// three atlases rasterised for the same bodies by the three-bracket path on the used rows and
// by the seven-bracket whole-atlas path read back RAW byte-identical (`__ml.coverParity`),
// at several moments of the walk, (3) the Settings switch flips the running path live both
// ways (7 then 3). Needs a built client (`npm run build -w client`). Exit 1 on any failure.
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
const errs=[]; page.on("pageerror",(e)=>errs.push(e.message)); page.on("console",(m)=>{ if(m.type()==="error") errs.push("[console] "+m.text().slice(0,200)); }); page.on("response",(r)=>{ if(r.status()>=400) errs.push(`[${r.status()}] ${r.url().slice(-100)}`); });
await page.addInitScript(()=>{localStorage.setItem("ml-last-choice",JSON.stringify({world:"the_game",characterUid:"default_boy",name:"W"}));sessionStorage.setItem("ml-rejoin","1");localStorage.removeItem("ml-cover-passes");});
await page.goto(origin+"/",{waitUntil:"commit"});
await page.waitForFunction(()=>{try{return !!window.__ml&&window.__ml.players()>=1;}catch{return false;}},null,{timeout:180000,polling:100});
const sleep=(ms)=>new Promise(r=>setTimeout(r,ms));
// The spawn house and the forest around it: walls, roofs and trees cover bodies.
const SPOTS = [[230,230],[333,233],[258,217],[277,269]];
let SEED=7; const rand=()=>((SEED=(SEED*1103515245+12345)&0x7fffffff)/0x7fffffff);
let failed = false; const fail=(m)=>{ failed=true; console.log("FAIL: "+m); };
const tap=async()=>page.evaluate(({a,d})=>{const m=window.__ml.me(); if(!m) return; const x=m.x+Math.cos(a)*d, y=m.y+Math.sin(a)*d; if(window.__ml.blockedAt(x,y)) return; const s=window.__ml.surfaceAt(x,y); if(!s||(!s.standable&&!s.swimmable)) return; window.__ml.tapTo(x,y,true);},{a:rand()*Math.PI*2,d:(6+rand()*10)*32});
let compared = 0, lastFlushes = -1, maxRows = 0, minRows = Infinity, rowsSeen = new Set();
const t0 = Date.now(); let spot = 0, lastTap = 0, lastSpot = 0;
while (Date.now()-t0 < 150000 && compared < 6) {
  if (Date.now()-lastSpot > 30000) { lastSpot = Date.now(); const [x,y] = SPOTS[spot++ % SPOTS.length]; await page.evaluate(([x,y])=>window.__ml.teleport(x,y),[x,y]); await sleep(4000); }
  if (Date.now()-lastTap > 5000) { lastTap = Date.now(); await tap(); }
  await sleep(1500);
  const c = await page.evaluate(()=>window.__ml.coverCost());
  if (!c.exact) { fail("cover surfaces not exact (no WebGL atlases)"); break; }
  if (c.flushes === lastFlushes || !c.slots) continue;
  lastFlushes = c.flushes;
  if (c.brackets !== 3) fail(`flush ran ${c.brackets} brackets, wanted 3`);
  if (!(c.rows >= 128 && c.rows <= 512 && c.rows % 128 === 0)) fail(`capture rows ${c.rows} not a 128-step within the atlas`);
  rowsSeen.add(c.rows); maxRows = Math.max(maxRows, c.rows); minRows = Math.min(minRows, c.rows);
  const p = await page.evaluate(()=>window.__ml.coverParity());
  if (p.error) { console.log(`t+${Math.round((Date.now()-t0)/1000)}s slots ${c.slots} — ${p.error}`); continue; }
  compared++;
  console.log(`t+${Math.round((Date.now()-t0)/1000)}s slots ${p.slots} rows ${p.rows} quads ${c.quads} cands ${c.cands}: ` + p.atlases.map(a=>`${a.key} ${a.error ?? (a.equal ? "IDENTICAL" : `diff ${a.diff} bytes, max delta ${a.maxDelta}`)}`).join(" | "));
  for (const a of p.atlases) if (a.error || !a.equal) fail(`${a.key}: ${a.error ?? `${a.diff} bytes differ (max delta ${a.maxDelta}) with ${p.slots} slots on ${p.rows} rows`}`);
}
console.log(`compared ${compared} flushes; capture rows seen ${[...rowsSeen].sort((a,b)=>a-b).join(",")||"none"}`);
if (compared < 3) fail(`only ${compared} flushes with a covered body compared (wanted 3+): the route found too little cover`);
// (3) the Settings switch, live: 7 whole-atlas brackets, then back to 3 on the used rows.
for (const [val, want] of [["7", 7], ["3", 3]]) {
  await page.evaluate((v)=>localStorage.setItem("ml-cover-passes", v), val);
  let c; for (let i=0;i<12;i++){ await tap(); await sleep(1500); c = await page.evaluate(()=>window.__ml.coverCost()); if (c.slots && c.brackets===want) break; }
  console.log(`  switch ml-cover-passes=${val}: brackets ${c.brackets} rows ${c.rows} slots ${c.slots} flushes ${c.flushes}`);
  if (c.brackets !== want) fail(`switch ${val}: brackets ${c.brackets}, wanted ${want}`);
  if (want === 7 && c.slots && c.rows !== 512) fail(`switch 7: rows ${c.rows}, wanted the whole atlas`);
}
const pf = await page.evaluate(()=>window.__ml.perf());
console.log("frames", JSON.stringify(pf.frames), "errs", errs.slice(0,5));
if (errs.some((e)=>/WebGL|GL_INVALID|framebuffer/i.test(e))) fail("GL error on the console: " + errs.find((e)=>/WebGL|GL_INVALID|framebuffer/i.test(e)));
console.log(failed ? "COVER FAILED" : "COVER OK");
await browser.close(); stop(); process.exit(failed ? 1 : 0);
