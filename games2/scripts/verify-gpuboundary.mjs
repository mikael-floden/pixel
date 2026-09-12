// THE GPU BOUNDARY (tiles3gpu.ts, the shader test) AGAINST THE CPU COMPOSER: one
// page, the same spot, a full paint each way at the same anchor, the ground
// textures compared texel by texel (docs/perf.md). Needs a built client.
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { PNG } from "pngjs";
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = process.env.OUT || "/tmp/claude-0/-home-user/9b663e9c-b357-5388-9df4-7e56e3039f71/scratchpad";
const port = 3300 + Math.floor(Math.random()*40); const origin = `http://127.0.0.1:${port}`;
const child = spawn(join(ROOT,"node_modules",".bin","tsx"),["src/index.ts"],{cwd:join(ROOT,"server"),detached:true,env:{...process.env,PORT:String(port),SERVE_CLIENT:"1",NODE_ENV:"production"},stdio:["ignore","ignore","ignore"]});
const stop=()=>{try{process.kill(-child.pid,"SIGKILL");}catch{}}; process.on("exit",stop);
for(let t0=Date.now();;){try{if((await fetch(origin+"/health")).ok)break;}catch{} if(Date.now()-t0>90000)throw new Error("unhealthy"); await new Promise(r=>setTimeout(r,250));}
const browser=await chromium.launch({executablePath:"/opt/pw-browsers/chromium-1194/chrome-linux/chrome",args:["--no-sandbox","--disable-dev-shm-usage"]});
const sleep=(ms)=>new Promise(r=>setTimeout(r,ms));
// ONE PAGE, TWO PAINTS: the CPU composer, then the shader forced on every
// boundary, both full paints at the same anchor — the diff is the shader alone.
const ctx=await browser.newContext({viewport:{width:412,height:732},serviceWorkers:"block"});
const page=await ctx.newPage();
const errs=[]; page.on("pageerror",(e)=>errs.push(e.message)); page.on("console",(m)=>{ if(/WebGL|shader|GL_|INVALID/i.test(m.text())) errs.push("[console] "+m.text().slice(0,200)); });
await page.addInitScript(()=>{localStorage.setItem("ml-last-choice",JSON.stringify({world:"the_game",characterUid:"default_boy",name:"P"}));sessionStorage.setItem("ml-rejoin","1");localStorage.setItem("ml-shader-test","0");});
await page.goto(origin+"/",{waitUntil:"commit"});
await page.waitForFunction(()=>{try{return !!window.__ml&&window.__ml.players()>=1;}catch{return false;}},null,{timeout:180000,polling:100});
await sleep(20000);
const paint = async (on) => page.evaluate(async (on)=>{ const s=window.__ml; s.shaderTest(on); s.groundRedraw(); await new Promise(r=>setTimeout(r,800)); s.groundRedraw(); await new Promise(r=>setTimeout(r,300)); const g=s.groundScroll(); const snap=await s.groundSnapshot(); return { drain:g.drain, anchor:g.anchor, snap, counts:s.perf().counts }; }, on);
const off = await paint(false); const on = await paint(true); const off2 = await paint(false);
console.log("OFF anchor", off.anchor, "gpuDraws", off.drain.gpuDraws, "builtB", off.drain.builtB, "textures", off.counts.textures);
console.log("ON  anchor", on.anchor, "gpuDraws", on.drain.gpuDraws, "builtB", on.drain.builtB, "textures", on.counts.textures);
console.log("errs", errs.slice(0,4));
const dec = (s) => PNG.sync.read(Buffer.from(s.url.split(",")[1], "base64"));
const A = dec(off.snap), B = dec(on.snap), A2 = dec(off2.snap);
{ let d=0; for (let i=0;i<A.data.length;i+=4) if (Math.abs(A.data[i]-A2.data[i])>8||Math.abs(A.data[i+1]-A2.data[i+1])>8||Math.abs(A.data[i+2]-A2.data[i+2])>8||Math.abs(A.data[i+3]-A2.data[i+3])>8) d++; console.log("CPU vs CPU repaint noise:", d, "texels", off2.anchor); }
writeFileSync(join(OUT,"gpu_off.png"), PNG.sync.write(A)); writeFileSync(join(OUT,"gpu_on.png"), PNG.sync.write(B));
if (A.width!==B.width||A.height!==B.height) { console.log("size differs", A.width, A.height, B.width, B.height); }
const sameAnchor = off.anchor && on.anchor && off.anchor.ax===on.anchor.ax && off.anchor.ay===on.anchor.ay;
console.log("same anchor:", sameAnchor, off.anchor, on.anchor);
// WORLD-SPACE OVERLAP: the two textures are anchored where each page's camera
// put them; compare only the region both cover.
const x0=Math.max(off.anchor.ax,on.anchor.ax), y0=Math.max(off.anchor.ay,on.anchor.ay);
const x1=Math.min(off.anchor.ax+A.width,on.anchor.ax+B.width), y1=Math.min(off.anchor.ay+A.height,on.anchor.ay+B.height);
console.log("overlap", x1-x0, "x", y1-y0);
let n=0, diff=0, sum=0, max=0; const D = new PNG({width:Math.max(1,x1-x0),height:Math.max(1,y1-y0)});
for (let y=y0;y<y1;y++) for (let x=x0;x<x1;x++){ const o=((y-off.anchor.ay)*A.width+(x-off.anchor.ax))*4, q=((y-on.anchor.ay)*B.width+(x-on.anchor.ax))*4, w=((y-y0)*D.width+(x-x0))*4; const a=A.data,b=B.data; if(a[o+3]===0&&b[q+3]===0){D.data[w+3]=255;continue;} n++; const d=Math.max(Math.abs(a[o]-b[q]),Math.abs(a[o+1]-b[q+1]),Math.abs(a[o+2]-b[q+2]),Math.abs(a[o+3]-b[q+3])); if(d>8){diff++;sum+=d;if(d>max)max=d;D.data[w]=255;D.data[w+3]=255;} else {D.data[w]=D.data[w+1]=D.data[w+2]=a[o]>>2;D.data[w+3]=255;} }
writeFileSync(join(OUT,"gpu_diff.png"), PNG.sync.write(D));
console.log(`texels ${n} differing(>8) ${diff} = ${(100*diff/Math.max(1,n)).toFixed(2)}% mean ${(sum/Math.max(1,diff)).toFixed(1)} max ${max}`);
await browser.close(); stop(); process.exit(0);
