// THE INDOOR FLIP IS INCREMENTAL (docs/perf.md): cross the cave mouth at 224,238
// four times headless and, after each crossing, hold the incremental occluder set
// against a full walk (sprites missing, extras inside the view, records) and the
// streamed ground texture against a full paint (hash + anchor). Prints the flip's
// perf sections at the end. `INC=0` runs the same legs through the full-paint path
// as the control. Needs a built client (`npm run build -w client`). Exit 1 on any
// sprite or record difference or a ground hash that differs from the full paint.
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
const page=await ctx.newPage(); const errs=[]; page.on("pageerror",(e)=>errs.push(e.message));
await page.addInitScript(()=>{localStorage.setItem("ml-last-choice",JSON.stringify({world:"the_game",characterUid:"default_boy",name:"C"}));sessionStorage.setItem("ml-rejoin","1");});
await page.goto(origin+"/",{waitUntil:"commit"});
await page.waitForFunction(()=>{try{return !!window.__ml&&window.__ml.players()>=1;}catch{return false;}},null,{timeout:180000,polling:100});
const sleep=(ms)=>new Promise(r=>setTimeout(r,ms));
await page.evaluate(()=>window.__ml.teleport(224,238)); await sleep(15000);
await page.evaluate((inc)=>{ if(!inc) window.__ml.occInc(false); window.__ml.perf(true); }, process.env.INC!=="0");
const legs=[[214,235],[226,239],[214,235],[226,239]];
let failed = false;
for (const [c,r] of legs) {
  await page.evaluate(([c,r])=>{ const p=window.__ml.cellToWorld? window.__ml.cellToWorld(c,r) : null; if (p) window.__ml.tapTo(p.x,p.y,true); else window.__ml.teleport(c,r); },[c,r]);
  for (let i=0;i<20;i++){ await sleep(500); const st=await page.evaluate(()=>({t:!!window.__ml.target(), f:window.__ml.indoorFade()})); if(!st.t) break; }
  const f=await page.evaluate(()=>window.__ml.indoorFade());
  await sleep(1500); // let the exit fade land
  const chk=await page.evaluate(async ()=>{ const s=window.__ml; const occ=s.occIncCheck(); const h1=s.groundHash(); s.groundRedraw(); await new Promise(r=>setTimeout(r,400)); const h2=s.groundHash(); const a1=JSON.stringify(h1&&(h1.anchor??[h1.ax,h1.ay])), a2=JSON.stringify(h2&&(h2.anchor??[h2.ax,h2.ay])); return { occ:{extraInView:occ.extraInView, slotDiff:occ.slotDiff, extraSprites:occ.extraSprites, sampleExtra:occ.sampleExtraSprites, sprites:occ.missingSprites, spriteSample:occ.sampleMissingSprites, cells:occ.missingCells, sample:occ.sampleMissing, missingImgs:occ.missingImgs, missingMeta:occ.missingMeta, extraMeta:occ.extraMeta, inc:occ.inc, full:occ.full}, ground:{same: !!h1 && !!h2 && h1.hash===h2.hash && a1===a2, anchorMoved: a1!==a2, h1: JSON.stringify(h1).slice(0,80)} }; });
  if (chk.occ.sprites || chk.occ.extraInView || chk.occ.missingMeta || chk.occ.extraMeta || !chk.ground.same) failed = true;
  console.log(`leg -> ${c},${r}: inside ${f.inside} cutCells ${f.cutCells} debris ${f.debris} | occ parity missingImgs ${chk.occ.missingImgs} missingMeta ${chk.occ.missingMeta} extraMeta ${chk.occ.extraMeta} (${chk.occ.inc}/${chk.occ.full}) | ground ${chk.ground.same?"= full paint":"DIFFERS from full paint"} | SPRITES missing ${chk.occ.sprites} extra ${chk.occ.extraSprites} (in view ${chk.occ.extraInView}) ${chk.occ.extraInView?JSON.stringify(chk.occ.sampleExtra):""} slotDiff ${JSON.stringify(chk.occ.slotDiff)}`); if (chk.occ.sprites) for (const c of chk.occ.cells) console.log("    cell", JSON.stringify(c));
}
const p = await page.evaluate(()=>window.__ml.perf());
const keys=["indoorMask","indoorCuts","roomTex","indoorDebris","occWalkInc","repaintCells","indoorMask","indoorCuts","roomTex","indoorDebris","redrawGround","occWalkFull","rebuildOccluders","rebuildScenery","coverIndex","render","depthSort","gapBusy","gapIdle"];
for (const k of keys) if (p.sections[k]) console.log(`  ${k.padEnd(16)} ${JSON.stringify(p.sections[k])}`);
console.log("frames", JSON.stringify(p.frames), "fullPaints", p.counts.fullPaints, "errs", errs.slice(0,3));
await browser.close(); stop(); process.exit(failed ? 1 : 0);
