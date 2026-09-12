// THE GROUND DETAILS' GATE (docs/tiles3-rendering.md): boot headless, check the
// pool carries tiles/tops post files for the grounds he approved details on, count
// the resolved cells carrying a detail at the default rate, then turn the dial to
// 1 in 4 and count again after the resolver rebuilt — the count must rise about
// 14x. Needs a built client. Exit 1 when the pool has no tops or the dial does
// not change the picture.
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
const ctx=await browser.newContext({viewport:{width:484,height:630},deviceScaleFactor:1,serviceWorkers:"block"});
const page=await ctx.newPage(); const errs=[]; page.on("pageerror",(e)=>errs.push(e.message));
await page.addInitScript(()=>{localStorage.setItem("ml-last-choice",JSON.stringify({world:"the_game",characterUid:"default_boy",name:"D"}));sessionStorage.setItem("ml-rejoin","1");localStorage.removeItem("ml-detail-every");});
await page.goto(origin+"/",{waitUntil:"commit"});
await page.waitForFunction(()=>{try{return !!window.__ml&&window.__ml.players()>=1;}catch{return false;}},null,{timeout:180000,polling:100});
await page.evaluate(([c,r])=>window.__ml.teleport(c,r),(process.env.AT||"236,206").split(",").map(Number)); await sleep(8000);
const a=await page.evaluate(()=>window.__ml.details());
const topsGrounds=Object.entries(a.pools).filter(([g,n])=>n>0).length;
console.log(`default: every ${a.every} (rate ${a.rate.toFixed(4)}) cells ${a.cells} withDetail ${a.withDetail} (${(100*a.withDetail/Math.max(1,a.cells)).toFixed(2)}%) pools ${JSON.stringify(a.pools)}`);
await page.evaluate(()=>window.__ml.details(4)); await sleep(4000);
const b=await page.evaluate(()=>window.__ml.details());
console.log(`1 in 4:  every ${b.every} (rate ${b.rate.toFixed(4)}) cells ${b.cells} withDetail ${b.withDetail} (${(100*b.withDetail/Math.max(1,b.cells)).toFixed(2)}%)`);
const rows=await page.evaluate(()=>{ const dials=document.querySelector('.ml-page[data-page="settings"] .ml-dials'); return dials?[...dials.querySelectorAll(".ml-amb-slider")].map(e=>[e.querySelector(".ml-amb-slider-label")?.textContent, e.querySelector(".ml-amb-slider-val")?.textContent]):null; });
console.log("dials:", JSON.stringify(rows), "errs", JSON.stringify(errs.slice(0,2)));
const ok = topsGrounds>=10 && a.every===56 && b.every===4 && b.withDetail > a.withDetail*4 && errs.length===0;
await browser.close(); stop(); process.exit(ok?0:1);
