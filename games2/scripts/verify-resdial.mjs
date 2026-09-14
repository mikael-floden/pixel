// THE RESOLUTION DIAL (client/src/resolution.ts, resdial.ts) HEADLESS: boot at 1, 2/3,
// 1/2, 1/3 and 1/4 and print the backing, the zoom and the visible world width — the world
// must stay the same width at every step while the backing shrinks — plus the
// Settings dials as the page shows them (the Resolution row sits above Light
// resolution, both in "1/k W×H" units). Needs a built client.
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
const probe = async (res) => {
  const ctx=await browser.newContext({viewport:{width:484,height:630},deviceScaleFactor:2.23,serviceWorkers:"block"});
  const page=await ctx.newPage(); const errs=[]; page.on("pageerror",(e)=>errs.push(e.message));
  await page.addInitScript((r)=>{localStorage.setItem("ml-last-choice",JSON.stringify({world:"the_game",characterUid:"default_boy",name:"R"}));sessionStorage.setItem("ml-rejoin","1");localStorage.setItem("ml-render-res", r);}, String(res));
  await page.goto(origin+"/",{waitUntil:"commit"});
  await page.waitForFunction(()=>{try{return !!window.__ml&&window.__ml.players()>=1;}catch{return false;}},null,{timeout:180000,polling:100});
  await sleep(4000);
  const r = await page.evaluate(()=>{ const g=window.__mlGame; const sc=g.scene.scenes[0]; const cam=sc.cameras.main; const dials=document.querySelector('.ml-page[data-page="settings"] .ml-dials'); const rows=dials?[...dials.querySelectorAll(".ml-amb-slider")].map(e=>[e.querySelector(".ml-amb-slider-label")?.textContent, e.querySelector(".ml-amb-slider-val")?.textContent]):null; return { backing:[g.scale.width,g.scale.height], css:[g.canvas.style.width,g.canvas.style.height], zoom:cam.zoom, worldW: g.scale.width/cam.zoom, rs:g.registry.get("renderScale"), rows }; });
  await ctx.close(); return { ...r, errs: errs.slice(0,3) };
};
for (const res of [1, 2 / 3, 0.5, 1 / 3, 0.25]) { const r = await probe(res); console.log(`res ${res}: backing ${r.backing} css ${r.css} zoom ${r.zoom} visible world ${r.worldW.toFixed(1)} px rs ${r.rs.toFixed(3)} errs ${JSON.stringify(r.errs)}`); console.log("   dials:", JSON.stringify(r.rows)); }
await browser.close(); stop(); process.exit(0);
