// A PAGE BEHIND THE SITE RELOADS ITSELF AT BOOT (docs/shipping.md), headless. Builds the client
// with VITE_GIT_SHA=<A> (~15 s; the dist it leaves behind carries that stamp), then (1) a server
// whose GIT_SHA is <B> serves it: the page reloads exactly once (a second main-frame navigation,
// type "reload"), still rejoins the world through the fast path (the rejoin flag survived), then
// BANNERS instead of reloading again (the bundle is still <A>); (2) a server whose GIT_SHA is <A>:
// no reload, no banner. Exit 1 on any failure.
import { spawn, spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const A = "a".repeat(40), B = "b".repeat(40);
const sleep=(ms)=>new Promise(r=>setTimeout(r,ms));
let failed = false; const fail=(m)=>{ failed=true; console.log("FAIL: "+m); };

console.log("building the client with VITE_GIT_SHA=" + A.slice(0,9) + "…");
const b = spawnSync("npm", ["run", "build:client"], { cwd: ROOT, env: { ...process.env, VITE_GIT_SHA: A }, stdio: ["ignore","ignore","inherit"] });
if (b.status !== 0) { console.log("client build failed"); process.exit(1); }

async function startServer(sha) {
  const port = 3300 + Math.floor(Math.random()*40); const origin = `http://127.0.0.1:${port}`;
  const child = spawn(join(ROOT,"node_modules",".bin","tsx"),["src/index.ts"],{cwd:join(ROOT,"server"),detached:true,env:{...process.env,PORT:String(port),SERVE_CLIENT:"1",NODE_ENV:"production",GIT_SHA:sha},stdio:["ignore","ignore","ignore"]});
  const stop=()=>{try{process.kill(-child.pid,"SIGKILL");}catch{}}; process.on("exit",stop);
  for(let t0=Date.now();;){try{if((await fetch(origin+"/health")).ok)break;}catch{} if(Date.now()-t0>90000){stop();throw new Error("unhealthy");} await sleep(250);}
  const v = await (await fetch(origin+"/version")).json();
  if (v.sha !== sha) fail(`server /version says ${v.sha}, wanted ${sha}`);
  return { origin, stop };
}

// The browser, wherever it is: a hardcoded /opt/pw-browsers/chromium-1194 path
// exists in the dev container and nowhere on a runner (it cost the fast lane its
// first CI run). CHROME_EXE overrides; undefined lets playwright resolve.
const EXE = process.env.CHROME_EXE || (()=>{ try {
  const base=process.env.PLAYWRIGHT_BROWSERS_PATH||"/opt/pw-browsers";
  for (const d of readdirSync(base)) if (d.startsWith("chromium")) {
    const f=`${base}/${d}/chrome-linux/chrome`; if (existsSync(f)) return f; }
} catch {} return undefined; })();
const browser=await chromium.launch({...(EXE?{executablePath:EXE}:{}),args:["--no-sandbox","--disable-dev-shm-usage"]});
async function scenario(name, served, expectReload, blockStorage = false) {
  const { origin, stop } = await startServer(served);
  const ctx=await browser.newContext({viewport:{width:412,height:732},serviceWorkers:"block"});
  const page=await ctx.newPage();
  const errs=[]; page.on("pageerror",(e)=>errs.push(e.message));
  const navs=[]; page.on("framenavigated",(f)=>{ if (f===page.mainFrame()) navs.push({url:f.url(),at:Date.now()}); });
  await page.addInitScript(()=>{localStorage.setItem("ml-last-choice",JSON.stringify({world:"the_game",characterUid:"default_boy",name:"W"}));sessionStorage.setItem("ml-rejoin","1");});
  // STORAGE BLOCKED: every sessionStorage access throws, as it does in private
  // mode, with site data blocked, and in some embedded webviews. The boot check
  // must then BANNER and never reload: its 60 s stamp cannot persist, and
  // `bootReloadOpen` is re-initialised by every load, so a reload here is
  // unbounded (measured 114 loads in 12 s on an identity mismatch).
  if (blockStorage) await page.addInitScript(()=>{
    const boom=()=>{throw new DOMException("blocked","SecurityError");};
    Object.defineProperty(window,"sessionStorage",{configurable:true,get:boom});
  });
  const t0 = Date.now();
  await page.goto(origin+"/",{waitUntil:"commit"});
  // The world through the rejoin fast path — across a reload if one comes (contexts die on navigation, so poll).
  // WITH STORAGE BLOCKED THIS ARM ASSERTS THE RELOAD RULE AND NOTHING ELSE, and
  // that boundary is measured, not assumed. A page whose `window.sessionStorage`
  // access throws does not reach the select screen AT ALL on this client — and
  // it does not reach it with a MATCHING server either, where the boot check
  // returns at `sha === mine` and cannot be involved (probed both ways: "at
  // select false after 31 s", 0 page errors, banner none). So that is a
  // SEPARATE, PRE-EXISTING defect — the game does not boot in a browser with
  // site data blocked, which is how Chrome behaves with cookies blocked — and
  // it needs its own unit. Asserting usability here would conflate the two and
  // hold a correct reload fix hostage to an unrelated gap.
  //
  // There is also no rejoin fast path with storage blocked, by construction:
  // that flag lives in sessionStorage too.
  let inWorld = false;
  if (!blockStorage) {
    for (let i=0;i<720 && !inWorld;i++){ await sleep(250); try { inWorld = await page.evaluate(()=>!!window.__ml && window.__ml.players()>=1); } catch {} }
  } else {
    await sleep(20_000); // long enough that a reload, if the guard failed, would have happened
  }
  const navType = await page.evaluate(()=>{ const e=performance.getEntriesByType("navigation")[0]; return e ? e.type : "?"; }).catch(()=>"?");
  const stamp = await page.evaluate(()=>sessionStorage.getItem("ml-boot-reload-at")).catch(()=>null);
  await sleep(8000); // long enough for a second reload to have happened if the guard were missing
  const navsAfter = navs.length;
  const banner = await page.evaluate(()=>{ const t=document.body.textContent||""; const m=t.match(/New version out ([0-9a-f]{9})/); return m ? m[1] : null; }).catch(()=>null);
  console.log(`${name}: navigations ${navsAfter} (type ${navType}), ${blockStorage?"(world not asserted: see the comment)":`in world ${inWorld}`} after ${Math.round((Date.now()-t0)/1000)-8}s, boot-reload stamp ${stamp?"set":"none"}, banner ${banner ?? "none"}, errors ${errs.length}`);
  if (!blockStorage && !inWorld) fail(`${name}: never reached the world (the rejoin fast path did not survive)`);
  if (expectReload) {
    if (navsAfter !== 2) fail(`${name}: ${navsAfter} main-frame navigations, wanted exactly 2 (one boot reload)`);
    if (navType !== "reload") fail(`${name}: the final document's navigation type is ${navType}, wanted reload`);
    if (!stamp) fail(`${name}: no ml-boot-reload-at stamp after the reload`);
    if (banner !== served.slice(0,9)) fail(`${name}: after the one reload the banner should offer ${served.slice(0,9)}, got ${banner}`);
  } else if (blockStorage) {
    // Behind, but unable to remember a reload: banner, and exactly one
    // navigation. A second navigation here IS the unbounded loop.
    if (navsAfter !== 1) fail(`${name}: ${navsAfter} main-frame navigations, wanted 1 — a reload it cannot remember is a LOOP`);
    if (banner !== served.slice(0,9)) fail(`${name}: should banner ${served.slice(0,9)} instead of reloading, got ${banner ?? "none"}`);
  } else {
    if (navsAfter !== 1) fail(`${name}: ${navsAfter} main-frame navigations, wanted 1 (no reload)`);
    if (stamp) fail(`${name}: a boot-reload stamp was written with a matching server`);
    if (banner) fail(`${name}: a banner (${banner}) with a matching server`);
  }
  for (const e of errs.slice(0,3)) console.log("  page error: " + e.slice(0,160));
  await ctx.close(); stop(); await sleep(500);
}
await scenario("behind  (bundle A, server B)", B, true);
await scenario("current (bundle A, server A)", A, false);
await scenario("behind, storage BLOCKED (bundle A, server B)", B, false, true);
console.log(failed ? "BOOTVERSION FAILED" : "BOOTVERSION OK");
await browser.close(); process.exit(failed ? 1 : 0);
