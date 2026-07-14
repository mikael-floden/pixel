import { PNG } from "pngjs";
import { chromium } from "playwright-core";
const EXE = "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
const browser = await chromium.launch({ executablePath: EXE, args: ["--no-sandbox","--disable-frame-rate-limit","--disable-gpu-vsync","--enable-unsafe-swiftshader"] });
const page = await browser.newPage({ viewport: { width: 1300, height: 800 } });
await page.goto("http://localhost:5173/#emission", { waitUntil: "load" });
await page.waitForSelector("input", { timeout: 20000 });
await page.fill("input", "detail"); await page.keyboard.press("Enter");
await page.waitForFunction(() => window.__ml?.nightShader?.() === true, null, { timeout: 30000 });
await page.waitForTimeout(2500);
await page.keyboard.press("6");
await page.evaluate(() => window.__ml.lookStation(94)); // mushroom
await page.waitForTimeout(1500);
// Compare CAP region (glowing detail, upper-centre of tile) vs BED region
// (non-glowing side, lower) swing over time — detail should swing MORE.
const region = async (x0,y0,x1,y1) => { const p=PNG.sync.read(await page.screenshot()); let s=0,n=0; for(let y=y0;y<y1;y++)for(let x=x0;x<x1;x++){const i=(y*p.width+x)*4;s+=p.data[i]+p.data[i+1]+p.data[i+2];n++;} return s/n/3; };
const caps=[], bed=[];
for(let k=0;k<16;k++){ caps.push(await region(600,250,700,300)); bed.push(await region(600,330,700,370)); await page.waitForTimeout(350); }
const sw = a => (Math.max(...a)-Math.min(...a));
console.log("CAP (glowing detail) swing:", sw(caps).toFixed(1), "mean", (caps.reduce((s,v)=>s+v)/caps.length).toFixed(1));
console.log("BED (non-glowing)   swing:", sw(bed).toFixed(1), "mean", (bed.reduce((s,v)=>s+v)/bed.length).toFixed(1));
// save peak/trough by cap brightness
let best={l:-1},worst={l:1e9};
for(let k=0;k<14;k++){ const buf=await page.screenshot({clip:{x:470,y:180,width:380,height:380}}); const p=PNG.sync.read(buf); let s=0,n=0; for(let y=70;y<130;y++)for(let x=130;x<250;x++){const i=(y*p.width+x)*4;s+=p.data[i]+p.data[i+1]+p.data[i+2];n++;} const l=s/n; if(l>best.l)best={l,buf}; if(l<worst.l)worst={l,buf}; await page.waitForTimeout(330);}
const fs=await import("node:fs"); fs.writeFileSync("/tmp/claude-0/-home-user/9b663e9c-b357-5388-9df4-7e56e3039f71/scratchpad/detail-peak.png",best.buf); fs.writeFileSync("/tmp/claude-0/-home-user/9b663e9c-b357-5388-9df4-7e56e3039f71/scratchpad/detail-trough.png",worst.buf);
await browser.close();
