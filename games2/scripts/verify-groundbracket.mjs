// THE GROUND BLIT IS THE PAINTED RECT'S (docs/perf.md, THE SLICE SIZE IS A GPU TRADE), headless:
// walk the maintainer's route and at several moments ask `__ml.groundBracketParity(sx, sy)`, which
// (1) repaints the cells around the avatar both ways over a poisoned ground texture — the blit
// scissored to the painted rect (the running path) and Phaser's whole-target blit — and compares
// the whole texture texel by texel; (2) scrolls the ground by a latch step, streams the owed band
// the running way and compares the result with a full paint at the same anchor (the live
// contract); (3) paints that band both ways over the poison and compares INSIDE the band, with
// nothing outside it touched by the scissored way. The scissored way must blit a fraction of the
// texels. Needs a built client (`npm run build -w client`). Exit 1 on any failure.
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
const errs=[]; page.on("pageerror",(e)=>errs.push(e.message)); page.on("console",(m)=>{ if(m.type()==="error") errs.push("[console] "+m.text().slice(0,200)); });
await page.addInitScript(()=>{localStorage.setItem("ml-last-choice",JSON.stringify({world:"the_game",characterUid:"default_boy",name:"W"}));sessionStorage.setItem("ml-rejoin","1");localStorage.removeItem("ml-ground-scissor");});
await page.goto(origin+"/",{waitUntil:"commit"});
await page.waitForFunction(()=>{try{return !!window.__ml&&window.__ml.players()>=1;}catch{return false;}},null,{timeout:180000,polling:100});
const sleep=(ms)=>new Promise(r=>setTimeout(r,ms));
await page.evaluate(()=>window.__ml.perf(true));
await page.evaluate(()=>window.__ml.teleport(230,230)); await sleep(8000);
let SEED=11; const rand=()=>((SEED=(SEED*1103515245+12345)&0x7fffffff)/0x7fffffff);
let failed = false; const fail=(m)=>{ failed=true; console.log("FAIL: "+m); };
const tap=async()=>page.evaluate(({a,d})=>{const m=window.__ml.me(); if(!m) return; const x=m.x+Math.cos(a)*d, y=m.y+Math.sin(a)*d; if(window.__ml.blockedAt(x,y)) return; const s=window.__ml.surfaceAt(x,y); if(!s||(!s.standable&&!s.swimmable)) return; window.__ml.tapTo(x,y,true);},{a:rand()*Math.PI*2,d:(8+rand()*10)*32});
let cellsOk = 0, bandsOk = 0, fullOk = 0, tries = 0;
let tightOk = 0;
const SPOTS = [[230,230],[258,217],[277,269],[304,200]];
// Latch steps: one axis each way (the band is one column or row of slices), then both (an L).
const STEPS = [[288,0],[0,288],[-288,0],[0,-288],[256,256],[-256,200]];
const t0 = Date.now();
while (Date.now()-t0 < 150000 && (cellsOk < 5 || bandsOk < 5 || fullOk < 5)) {
  const [sx,sy] = SPOTS[tries % SPOTS.length];
  await page.evaluate(([x,y,dx])=>window.__ml.teleport(x+dx,y),[sx,sy,(tries%3)*9]);
  await sleep(5000); // the art around the spot lands and its owed cells repaint before the picture is judged
  const [stx, sty] = STEPS[tries % STEPS.length]; tries++;
  const r = await page.evaluate(([a,b])=>window.__ml.groundBracketParity(a,b),[stx,sty]);
  if (r.error) { console.log(`t+${Math.round((Date.now()-t0)/1000)}s — ${r.error}`); await sleep(2000); await tap(); await sleep(2500); continue; }
  const c = r.cellsCmp, l = r.liveCmp, f = r.fullCmp, fw = r.fullWholeCmp, s = r.sliceCmp;
  const say = (x) => x.error ?? (x.equal && !x.diffOut ? "IDENTICAL" : `diff in ${x.diff} out ${x.diffOut}${x.poisonOut ? ` (+${x.poisonOut} unpoisoned)` : ""}, max delta ${x.maxDelta}, box ${JSON.stringify(x.box)}`);
  console.log(`t+${Math.round((Date.now()-t0)/1000)}s ${r.w}x${r.h} cells ${r.cells}: ${say(c)} blit ${c.blitPxScissor} / whole ${c.blitPxWhole}` +
    ` | step ${stx},${sty} live scissored vs whole: ${l ? say(l) : "-"}` +
    ` | vs full: scissored ${f ? say(f) : "-"}; whole ${fw ? say(fw) : "-"}` +
    (s ? ` | band ${JSON.stringify(s.rect)} (${s.slices} slices): ${say(s)}; blit ${s.blitPxScissor} / ${s.blitPxWhole}` : " | no band") +
    (r.owed ? ` | owed ${JSON.stringify(r.owed)}` : ""));
  if (c.error || !c.equal) fail(`cells: ${say(c)}`); else cellsOk++;
  if (!(c.blitPxScissor > 0 && c.blitPxScissor * 3 < c.blitPxWhole)) fail(`cells: the scissored way blitted ${c.blitPxScissor} texels against ${c.blitPxWhole} whole — not a fraction`);
  // Inside the band the two ways must agree over the real picture; outside it the whole way
  // repaints the spill, and what that is worth is the full-paint columns above.
  if (!l || l.error || l.diff !== 0) fail(`live scissored vs whole inside the band (step ${stx},${sty}): ${l ? say(l) : "no comparison"}`); else fullOk++;
  if (f && fw && !f.error && !fw.error && f.diff + f.diffOut > fw.diff + fw.diffOut) fail(`the scissored picture is further from a full paint (${f.diff + f.diffOut} texels) than the whole one (${fw.diff + fw.diffOut})`);
  if (!s || s.error || s.diff !== 0 || s.poisonOut !== 0) fail(`band over the poison (step ${stx},${sty}): ${s ? say(s) : "no comparison"}`); else bandsOk++;
  // THE TIGHT BAND (2026-09-24): a band pass walks only the cells that can reach its rect — no texel may change.
  const t = r.tightCmp, ct = r.cellsTightCmp;
  console.log(`  tight band: ${t ? say(t) : "-"} | tight cells: ${ct ? say(ct) : "-"}`);
  if (!t || t.error || t.diff !== 0 || t.poisonOut !== 0) fail(`the tight band changed texels (step ${stx},${sty}): ${t ? say(t) : "no comparison"}`); else tightOk++;
  if (!ct || ct.error || ct.diff !== 0) fail(`the tight cell repaint changed texels: ${ct ? say(ct) : "no comparison"}`);
  // One axis: the band is a column or a row of the texture. Both axes: an L whose union is most of it.
  if (s && !s.error && (stx === 0 || sty === 0) && !(s.blitPxScissor > 0 && s.blitPxScissor * 3 < s.blitPxWhole)) fail(`band: blitted ${s.blitPxScissor} against ${s.blitPxWhole}`);
  await sleep(1500); await tap(); await sleep(2500);
}
console.log(`compared: cells ${cellsOk}, live bands ${fullOk}, poisoned bands ${bandsOk}, in ${tries} tries`);
if (cellsOk < 4) fail(`only ${cellsOk} cell comparisons (wanted 4+)`);
if (fullOk < 4) fail(`only ${fullOk} live band comparisons (wanted 4+)`);
if (bandsOk < 4) fail(`only ${bandsOk} band comparisons (wanted 4+)`);
if (tightOk < 4) fail(`only ${tightOk} tight-band comparisons (wanted 4+)`);
const gs = await page.evaluate(()=>{ try { return localStorage.getItem("ml-ground-scissor"); } catch { return "?"; } });
console.log(`ml-ground-scissor after: ${gs} (null = the default, on); errs ${errs.length}`, errs.slice(0,3));
if (gs === "0") fail("the probe left the ground blit switched to whole");
if (errs.some((e)=>/WebGL|GL_INVALID|framebuffer/i.test(e))) fail("GL error on the console: " + errs.find((e)=>/WebGL|GL_INVALID|framebuffer/i.test(e)));
console.log(failed ? "GROUNDBRACKET FAILED" : "GROUNDBRACKET OK");
await browser.close(); stop(); process.exit(failed ? 1 : 0);
