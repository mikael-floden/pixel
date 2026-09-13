// A PAGE BEHIND THE SITE RELOADS ITSELF AT BOOT (docs/shipping.md), headless. Builds the client
// with VITE_GIT_SHA=<A> (~15 s; the dist it leaves behind carries that stamp), then (1) a server
// whose GIT_SHA is <B> serves it: the page reloads exactly once (a second main-frame navigation,
// type "reload"), still rejoins the world through the fast path (the rejoin flag survived), then
// BANNERS instead of reloading again (the bundle is still <A>); (2) a server whose GIT_SHA is <A>:
// no reload, no banner. Exit 1 on any failure.
import { spawn, spawnSync } from "node:child_process";
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

const browser=await chromium.launch({executablePath:"/opt/pw-browsers/chromium-1194/chrome-linux/chrome",args:["--no-sandbox","--disable-dev-shm-usage"]});
async function scenario(name, served, expectReload) {
  const { origin, stop } = await startServer(served);
  const ctx=await browser.newContext({viewport:{width:412,height:732},serviceWorkers:"block"});
  const page=await ctx.newPage();
  const errs=[]; page.on("pageerror",(e)=>errs.push(e.message));
  const navs=[]; page.on("framenavigated",(f)=>{ if (f===page.mainFrame()) navs.push({url:f.url(),at:Date.now()}); });
  await page.addInitScript(()=>{localStorage.setItem("ml-last-choice",JSON.stringify({world:"the_game",characterUid:"default_boy",name:"W"}));sessionStorage.setItem("ml-rejoin","1");});
  const t0 = Date.now();
  await page.goto(origin+"/",{waitUntil:"commit"});
  // The world through the rejoin fast path — across a reload if one comes (contexts die on navigation, so poll).
  let inWorld = false;
  for (let i=0;i<720 && !inWorld;i++){ await sleep(250); try { inWorld = await page.evaluate(()=>!!window.__ml && window.__ml.players()>=1); } catch {} }
  const navType = await page.evaluate(()=>{ const e=performance.getEntriesByType("navigation")[0]; return e ? e.type : "?"; }).catch(()=>"?");
  const stamp = await page.evaluate(()=>sessionStorage.getItem("ml-boot-reload-at")).catch(()=>null);
  await sleep(8000); // long enough for a second reload to have happened if the guard were missing
  const navsAfter = navs.length;
  const banner = await page.evaluate(()=>{ const t=document.body.textContent||""; const m=t.match(/New version out ([0-9a-f]{9})/); return m ? m[1] : null; }).catch(()=>null);
  console.log(`${name}: navigations ${navsAfter} (type ${navType}), in world ${inWorld} after ${Math.round((Date.now()-t0)/1000)-8}s, boot-reload stamp ${stamp?"set":"none"}, banner ${banner ?? "none"}, errors ${errs.length}`);
  if (!inWorld) fail(`${name}: never reached the world (the rejoin fast path did not survive)`);
  if (expectReload) {
    if (navsAfter !== 2) fail(`${name}: ${navsAfter} main-frame navigations, wanted exactly 2 (one boot reload)`);
    if (navType !== "reload") fail(`${name}: the final document's navigation type is ${navType}, wanted reload`);
    if (!stamp) fail(`${name}: no ml-boot-reload-at stamp after the reload`);
    if (banner !== served.slice(0,9)) fail(`${name}: after the one reload the banner should offer ${served.slice(0,9)}, got ${banner}`);
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
console.log(failed ? "BOOTVERSION FAILED" : "BOOTVERSION OK");
await browser.close(); process.exit(failed ? 1 : 0);
