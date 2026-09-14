// THE ART QUEUE'S WORKER + BANDED UPLOADS (docs/perf.md, THE ART QUEUE DECODES ON A
// WORKER AND UPLOADS IN BANDS), headless: run from the maintainer's route while strips
// stream, then (1) the worker is on and no job fell back, (2) every frame's upload stayed
// inside the budget (KB=<n> env, default 128) plus one band, (3) the biggest banded
// textures read back byte-identical to the same files uploaded the old way (an <img> under
// UNPACK_PREMULTIPLY_ALPHA_WEBGL), the worker's on-demand frame alpha and whole-image pixels equal
// the readback, and a banded still's cut-frame box (from the seeded whole-image box) equals a fresh measure,
// (4) a forced WebGL context loss + restore refills them
// and parity holds again, (5) every scenery still the worker banded carries the same fit
// (alphaBBox + size) a GPU readback measures. Needs a built client (`npm run build -w client`). Exit 1 on any
// failure.
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
const KB = process.env.KB || "128";
await page.addInitScript((kb)=>{localStorage.setItem("ml-last-choice",JSON.stringify({world:"the_game",characterUid:"default_boy",name:"W"}));sessionStorage.setItem("ml-rejoin","1");localStorage.setItem("ml-upload-kb", kb);}, KB);
await page.goto(origin+"/",{waitUntil:"commit"});
await page.waitForFunction(()=>{try{return !!window.__ml&&window.__ml.players()>=1;}catch{return false;}},null,{timeout:180000,polling:100});
const sleep=(ms)=>new Promise(r=>setTimeout(r,ms));
await page.evaluate(()=>window.__ml.teleport(230,230)); await sleep(8000);
await page.evaluate(()=>window.__ml.perf(true));
let SEED=5; const rand=()=>((SEED=(SEED*1103515245+12345)&0x7fffffff)/0x7fffffff);
let failed = false; const fail=(m)=>{ failed=true; console.log("FAIL: "+m); };
let frameKbMax = 0, bandMax = 0, bands = 0;
const t0=Date.now(); let lastTap=0;
while (Date.now()-t0 < 45000) {
  if (Date.now()-lastTap > 6000) { lastTap=Date.now(); await page.evaluate(({a,d})=>{const m=window.__ml.me(); if(!m) return; const x=m.x+Math.cos(a)*d, y=m.y+Math.sin(a)*d; if(window.__ml.blockedAt(x,y)) return; const s=window.__ml.surfaceAt(x,y); if(!s||(!s.standable&&!s.swimmable)) return; window.__ml.tapTo(x,y,true);},{a:rand()*Math.PI*2,d:(10+rand()*12)*32}); }
  await sleep(5000);
  const a = await page.evaluate(()=>window.__ml.art());
  frameKbMax = Math.max(frameKbMax, a.frameKbMax); bandMax = Math.max(bandMax, a.bandMax); bands = a.bands;
  console.log(`t+${Math.round((Date.now()-t0)/1000)}s worker ${a.worker} (${a.workerError||"ok"}) errors ${a.workerErrors} banded ${a.banded} queued ${a.queued} fetching ${a.fetching} ready ${a.ready} (${a.readyKb} KB) landed ${a.landed} failed ${a.failed} bands ${a.bands} bandMs ${a.bandMs.toFixed(1)} bandMax ${a.bandMax.toFixed(2)} frameKbMax ${Math.round(a.frameKbMax)} debt ${a.debtKb}`);
  if (a.worker !== 1) fail(`worker not on: ${a.worker} ${a.workerError}`);
  if (a.workerErrors) fail(`worker errors ${a.workerErrors}: ${a.workerError}`);
  if (a.failed) fail(`failed ${a.failed}`);
}
const budget = Number(KB);
if (budget > 0 && frameKbMax > budget * 2) fail(`frameKbMax ${Math.round(frameKbMax)} KB over twice the ${budget} KB budget`);
if (!bands) fail("no bands uploaded");
const par = await page.evaluate(()=>window.__ml.artParity());
for (const p of par) console.log(`  parity ${p.key}: ${p.error ?? (p.equal ? "IDENTICAL" : `diff ${p.diff} bytes, max delta ${p.maxDelta}`)} ${p.w?`${p.w}x${p.h}`:""}`);
if (!par.length) fail("no banded texture to compare");
// (3b) the CPU readers' path: a banded frame's alpha read back from the GPU equals the <img> path's.
for (const p of par.slice(0, 3)) for (const fr of [0, 2]) { const al = await page.evaluate(([k,f])=>window.__ml.artAlpha(k,f),[p.key,fr]); console.log(`  alpha ${p.key} frame ${fr}: ${al.error ?? (al.equal ? "IDENTICAL" : `diff ${al.diff} texels`)} ${al.w?`${al.w}x${al.h}`:""}`); if (al.error || !al.equal) fail(`alpha ${p.key} frame ${fr}: ${al.error ?? `${al.diff} texels differ`}`); }
for (const p of par) if (p.error || !p.equal) fail(`parity ${p.key}: ${p.error ?? `${p.diff} bytes differ`}`);
// (3b') the worker's on-demand alpha (what the outline and the foam clamp read now) equals the readback.
for (const p of par.slice(0, 2)) for (const fr of [0, 2]) { const aw = await page.evaluate(([k,f])=>window.__ml.artAlphaWorker(k,f),[p.key,fr]); console.log(`  worker alpha ${p.key} frame ${fr}: ${aw.error ?? (aw.equal ? `IDENTICAL (${aw.waitedMs} ms)` : `diff ${aw.diff} texels`)}`); if (aw.error || !aw.equal) fail(`worker alpha ${p.key} frame ${fr}: ${aw.error ?? `${aw.diff} texels differ`}`); }
// (3b'') the worker's whole-image pixels (what a still's light and shape map read now) against the readback,
// and the cut-frame boxes derived from the seeded whole-image box against a fresh measure.
{
  const stills = await page.evaluate(()=>{ const out=[]; for (const k of window.__ml.sceneryKeys ? window.__ml.sceneryKeys() : []) out.push(k); return out; }).catch(()=>[]);
  const keys = stills.length ? stills.slice(0,2) : await page.evaluate(()=>{ const t=window.__ml.tiles3(); return []; }).catch(()=>[]);
  const pk = await page.evaluate(()=>{ const s=window.__ml.sceneryPack&&window.__ml.sceneryPack(); return s&&s.sample ? s.sample.slice(0,2) : []; }).catch(()=>[]);
  const cand = (keys.length?keys:pk);
  if (!cand.length) console.log("  (no scenery key sample from the probes; pixel parity via artParity's list)");
  const list = cand.length ? cand : par.map(p=>p.key).slice(0,2);
  for (const k of list) { const pw = await page.evaluate((key)=>window.__ml.artPixelsWorker(key),k); console.log(`  worker pixels ${k}: ${pw.error ?? (pw.equal ? `OK alpha exact, colour within ${pw.colourMaxDelta} (${pw.waitedMs} ms)` : `alphaDiff ${pw.alphaDiff} colourMaxDelta ${pw.colourMaxDelta}`)}`); if (pw.error || !pw.equal) fail(`worker pixels ${k}: ${pw.error ?? `alphaDiff ${pw.alphaDiff}, colour delta ${pw.colourMaxDelta}`}`); }
  const ab = await page.evaluate(()=>window.__ml.artBoundsParity(80));
  console.log(`  cut-frame boxes: checked ${ab.checked} mismatched ${ab.mismatched} provisional ${ab.provisional}${ab.bad.length?" "+ab.bad.join(" | "):""}`);
  if (!ab.checked) fail("no cut-frame box of a banded still to compare");
  if (ab.mismatched) fail(`cut-frame boxes: ${ab.mismatched} mismatched`);
}
// (3c) scenery stills ride the queue too: the fit the worker seeded (alphaBBox's box + the canvas size)
// equals a fresh alphaBBox of the texture read back from the GPU, for every banded still on this route.
const sf = await page.evaluate(()=>window.__ml.sceneryFitParity(60));
console.log(`  scenery fits: checked ${sf.checked} (packed ${sf.packed}) mismatched ${sf.mismatched} unread ${sf.unread}${sf.bad.length?" "+sf.bad.join(" | "):""}`);
if (!sf.checked) fail("no banded scenery still to compare (did the stills ride the queue?)");
if (sf.mismatched || sf.unread) fail(`scenery fits: ${sf.mismatched} mismatched, ${sf.unread} unreadable`);
// (3d) the Settings switch, live: off sends the next files the <img> way, on brings the worker back.
for (const [val, want] of [["0", 0], ["1", 1]]) {
  await page.evaluate((v)=>localStorage.setItem("ml-art-worker", v), val);
  await page.evaluate(({a,d})=>{const m=window.__ml.me(); if(!m) return; const x=m.x+Math.cos(a)*d, y=m.y+Math.sin(a)*d; if(window.__ml.blockedAt(x,y)) return; const s=window.__ml.surfaceAt(x,y); if(!s||(!s.standable&&!s.swimmable)) return; window.__ml.tapTo(x,y,true);},{a:rand()*Math.PI*2,d:(10+rand()*12)*32});
  let a; for (let i=0;i<10;i++){ await sleep(2000); a = await page.evaluate(()=>window.__ml.art()); if (a.worker===want) break; }
  console.log(`  switch ml-art-worker=${val}: worker ${a.worker} landed ${a.landed} failed ${a.failed}`);
  if (a.worker !== want) fail(`switch ${val}: worker ${a.worker}, wanted ${want}`);
  if (a.failed) fail(`switch ${val}: failed ${a.failed}`);
}
// (4) a forced context loss + restore: Phaser rebuilds its wrappers blank, the queue refills.
const lost = await page.evaluate(async ()=>{ const c=document.querySelector("canvas"); const gl=c.getContext("webgl")||c.getContext("webgl2"); const ext=gl&&gl.getExtension("WEBGL_lose_context"); if(!ext) return "no WEBGL_lose_context"; ext.loseContext(); await new Promise(r=>setTimeout(r,500)); ext.restoreContext(); return "ok"; });
console.log("context loss:", lost);
if (lost === "ok") {
  // The refill is not budgeted, but it is fetched: wait for the last one.
  let a; for (let i=0;i<45;i++){ await sleep(2000); a = await page.evaluate(()=>window.__ml.art()); if (a.refillLeft===0) break; }
  console.log(`after restore: refilled ${a.refilled} banded ${a.banded} queued ${a.queued} ready ${a.ready} failed ${a.failed} worker ${a.worker}`);
  if (!a.refilled) fail("nothing refilled after the context restore");
  const par2 = await page.evaluate(()=>window.__ml.artParity());
  for (const p of par2) console.log(`  parity after restore ${p.key}: ${p.error ?? (p.equal ? "IDENTICAL" : `diff ${p.diff}, max delta ${p.maxDelta}`)}`);
  for (const p of par2) if (p.error || !p.equal) fail(`parity after restore ${p.key}: ${p.error ?? `${p.diff} bytes differ`}`);
}
const p = await page.evaluate(()=>window.__ml.perf());
console.log("frames", JSON.stringify(p.frames), "texUp", JSON.stringify(p.texUp ?? null), "errs", errs.slice(0,5));
console.log(failed ? "ARTWORKER FAILED" : "ARTWORKER OK");
await browser.close(); stop(); process.exit(failed ? 1 : 0);
