// A SCENERY CLIP PLAYS ONLY ON FRAMES THAT ARE ON THE GPU (docs/scenery.md, "Clips"), headless,
// at the maintainer's streetlight (streetlights/streetlight_007 LIT_2 at 320.9,219.9): (1) a forced
// play swaps frames 1-4 in with the image's box, scale and cut unchanged; (2) after a WebGL context
// loss and restore (`__ml.glLose`) every banded texture is blank until the art queue refills it —
// while any frame of the clip is still owed, the run shows nothing past the still; (3) once every
// frame is refilled the clip plays again. Needs a built client (`npm run build -w client`). Exit 1
// on any failure.
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const port = 3300 + Math.floor(Math.random()*40); const origin = `http://127.0.0.1:${port}`;
const child = spawn(join(ROOT,"node_modules",".bin","tsx"),["src/index.ts"],{cwd:join(ROOT,"server"),detached:true,env:{...process.env,PORT:String(port),SERVE_CLIENT:"1",NODE_ENV:"production"},stdio:["ignore","ignore","ignore"]});
const stop=()=>{try{process.kill(-child.pid,"SIGKILL");}catch{}}; process.on("exit",stop);
for(let t0=Date.now();;){try{if((await fetch(origin+"/health")).ok)break;}catch{} if(Date.now()-t0>90000)throw new Error("unhealthy"); await new Promise(r=>setTimeout(r,250));}
const browser=await chromium.launch({executablePath:"/opt/pw-browsers/chromium-1194/chrome-linux/chrome",args:["--no-sandbox","--disable-dev-shm-usage"]});
// His phone's CSS geometry; dpr 1 keeps the headless loop fast enough to step a 625 ms clip.
const ctx=await browser.newContext({viewport:{width:393,height:851},deviceScaleFactor:1,isMobile:true,hasTouch:true,serviceWorkers:"block"});
const page=await ctx.newPage();
const errs=[]; page.on("pageerror",(e)=>errs.push(e.message)); page.on("console",(m)=>{ if(m.type()==="error") errs.push("[console] "+m.text().slice(0,200)); });
await page.addInitScript(()=>{localStorage.setItem("ml-last-choice",JSON.stringify({world:"the_game",characterUid:"default_boy",name:"W"}));sessionStorage.setItem("ml-rejoin","1");});
await page.goto(origin+"/",{waitUntil:"commit"});
await page.waitForFunction(()=>{try{return !!window.__ml&&window.__ml.players()>=1;}catch{return false;}},null,{timeout:180000,polling:100});
const sleep=(ms)=>new Promise(r=>setTimeout(r,ms));
let failed = false; const fail=(m)=>{ failed=true; console.log("FAIL: "+m); };
await page.evaluate(()=>window.__ml.teleport(319.6,221.7)); await sleep(6000);
const near = await page.evaluate(()=>window.__ml.sceneryNear(320,220,3));
const lamp = near.find((p)=>p.piece==="streetlights/streetlight_007");
if (!lamp) { fail("streetlight_007 not placed near 320,220 — the world moved under this gate"); console.log("SCENERYANIM FAILED"); await browser.close(); stop(); process.exit(1); }
const PLACE = lamp.i;
const detail=(play=false)=>page.evaluate(([pl,p])=>window.__ml.sceneryAnims(p?{play:true,place:pl}:{place:pl}).detail,[PLACE,play]);
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
// (1) Frames land (re-asked at the head of the queue) and swap in without moving the box.
let d0 = null;
for (let t0=Date.now(); Date.now()-t0<40000;) { const d=await detail(true); if (d?.run?.resident) { d0=d; break; } await sleep(200); }
if (!d0) { fail("the clip's frames never became resident"); }
else {
  const box0 = d0.img;
  console.log(`still ${d0.still} cut ${JSON.stringify(d0.stillCut.cut)} box ${JSON.stringify(box0)}`);
  const seen = new Map();
  for (let t0=Date.now(); Date.now()-t0<10000 && seen.size<4;) {
    const d=await detail(true); const f=d.run.frame;
    if (f>=1 && !seen.has(f)) {
      seen.set(f, d);
      const fr = d.frames[f];
      const boxSame = ["x","y","w","h","sx","sy"].every((k)=>Math.abs(d.img[k]-box0[k])<1e-6);
      const cutSame = same(fr.tex, d0.stillCut.tex) ? same(fr.cut, d0.stillCut.cut) : !!fr.cut;
      console.log(`frame ${f}: tex ${JSON.stringify(fr.tex)} cut ${JSON.stringify(fr.cut)} box ${boxSame ? "unchanged" : "MOVED " + JSON.stringify(d.img)}; image shows ${d.img.tex.slice(-22)}`);
      if (!boxSame) fail(`frame ${f} moved the image's box`);
      if (!cutSame) fail(`frame ${f}'s cut ${JSON.stringify(fr.cut)} differs from the still's ${JSON.stringify(d0.stillCut.cut)} on a same-size texture`);
      if (!d.img.tex.endsWith(`/0${f}.webp`)) fail(`frame ${f} shows texture ${d.img.tex}`);
    }
    await sleep(30);
  }
  if (seen.size<4) fail(`only frames ${[...seen.keys()].join(",")} were seen in 10 s (wanted 1-4)`);
  // (2) Lose the context: blank textures, refills owed; the clip must not play until they land.
  const lost = await page.evaluate(()=>window.__ml.glLose(300));
  if (lost.error) fail("glLose: "+lost.error);
  await sleep(700);
  let owedPolls=0, shownWhileOwed=0, refillLeft0=-1, imgWhileOwed=new Set();
  for (let t0=Date.now(); Date.now()-t0<30000;) {
    const d=await detail(true); const art=await page.evaluate(()=>window.__ml.art());
    if (refillLeft0<0) refillLeft0=art.refillLeft;
    const owed = d.frames.some((f)=>f.refilling) || d.stillCut?.refilling;
    if (!owed && art.refillLeft===0) break;
    if (owed) { owedPolls++; if (d.run.frame>=1) { shownWhileOwed++; imgWhileOwed.add(d.img.tex.slice(-22)); } }
    await sleep(30);
  }
  console.log(`after the restore: refills owed ${refillLeft0}; polls with the clip's frames owed ${owedPolls}, of which showing a frame past the still ${shownWhileOwed} ${[...imgWhileOwed].join(",")}`);
  if (refillLeft0<=0) fail("the context loss owed no refills — the restore path did not run");
  if (owedPolls<3) fail(`the frames were owed for only ${owedPolls} polls — too quick to judge`);
  if (shownWhileOwed>0) fail(`the clip showed a frame ${shownWhileOwed} times while that frame's texture was blank behind a refill`);
  // (3) Refilled: it plays again.
  let again=false;
  for (let t0=Date.now(); Date.now()-t0<15000;) { const d=await detail(true); if (d.run.frame>=1 && !d.frames.some((f)=>f.refilling)) { again=true; break; } await sleep(30); }
  console.log(`plays again after the refills: ${again}`);
  if (!again) fail("the clip never played again after its frames were refilled");
}
// (4) A TURNED PIECE PLAYS ITS OWN CLIP. The manifests publish one clip per
//     facing (animations.<name>.directions.<dir>), the parser read only the flat
//     south one, and a south-east hearth therefore drew its south-east still
//     until its flame played — then swapped to the SOUTH frames for the length
//     of the clip and swapped back (maintainer 2026-09-14: "The scenery object
//     next to me turns S when it plays the animation and then turns back SE
//     again ... You don't turn objects just to play their animation!"). The
//     placement is DERIVED from the world doc: the first turned one whose state
//     publishes a clip for the facing it is placed in.
const world = JSON.parse(readFileSync(join(ROOT,"..","maps2","worlds3","the_game","world.json"),"utf8"));
const turnedAll = [];
for (const pl of world.scenery ?? []) {
  if (!pl.dir || pl.dir === "south") continue;
  const mf = join(ROOT,"..","scenery",pl.piece,"scenery.json");
  if (!existsSync(mf)) continue;
  const st = (JSON.parse(readFileSync(mf,"utf8")).states ?? {})[pl.state] ?? {};
  for (const a of Object.values(st.animations ?? {}))
    if ((a.directions?.[pl.dir]?.frame_paths ?? []).length) { turnedAll.push(pl); break; }
}
// Most of them are INDOOR furniture (drawn only while their roof is cut away)
// and a clip only runs if the review approves it, so walk the candidates until
// one actually registers a run rather than betting on the first.
let turned = null;
let rec = null;
for (const cand of turnedAll) {
  for (const [dc,dr] of [[0,1],[0,0],[1,1],[-1,1]]) {
    await page.evaluate(([c,r])=>window.__ml.teleport(c,r),[cand.x+dc,cand.y+dr]);
    await sleep(5000);
    const near = await page.evaluate(([c,r])=>window.__ml.sceneryNear(Math.floor(c),Math.floor(r),3),[cand.x,cand.y]);
    const hit = near.find((p)=>p.piece===cand.piece && p.dir===cand.dir) ?? null;
    if (!hit) continue;
    const d = await page.evaluate((pl)=>window.__ml.sceneryAnims({play:true,place:pl}).detail,hit.i);
    if (d?.frames?.length) { turned = cand; rec = hit; break; }
  }
  if (rec) break;
}
if (!turned || !rec) fail(`no turned placement with a clip of its own is drawn and playable (${turnedAll.length} candidates) — the facing rule is unmeasured on this world`);
else {
  {
    const d = await page.evaluate((pl)=>window.__ml.sceneryAnims({play:true,place:pl}).detail,rec.i);
    const frames = (d?.frames ?? []).map((f)=>f.key);
    console.log(`turned piece ${turned.piece} ${turned.dir}: still ${d?.still?.slice(-34)}, clip ${frames[0] ?? "none"}`);
    if (!frames.length) fail(`${turned.piece} registered no clip at all`);
    else if (!frames.every((k)=>k.includes(`/${turned.dir}/`)))
      fail(`it plays the SOUTH clip on its ${turned.dir} still (${frames[0]}) — the object turns to animate`);
    if (d?.still && !d.still.includes(turned.dir)) fail(`its still is not the ${turned.dir} rotation (${d.still})`);
  }
}
if (errs.some((e)=>/WebGL|GL_INVALID|framebuffer/i.test(e))) fail("GL error on the console: " + errs.find((e)=>/WebGL|GL_INVALID|framebuffer/i.test(e)));
console.log(failed ? "SCENERYANIM FAILED" : "SCENERYANIM OK");
await browser.close(); stop(); process.exit(failed ? 1 : 0);
