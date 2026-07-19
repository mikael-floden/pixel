import { PNG } from "pngjs";
import { chromium } from "playwright-core";
const EXE = "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
const SP = "/tmp/claude-0/-home-user/9b663e9c-b357-5388-9df4-7e56e3039f71/scratchpad";
const browser = await chromium.launch({ executablePath: EXE, args: ["--no-sandbox"] });
const page = await browser.newPage({ viewport: { width: 1600, height: 1200 } });
await page.goto("http://localhost:5173/", { waitUntil: "load" });
await page.waitForSelector("input", { timeout: 20000 });
await page.fill("input", "gwarp"); await page.keyboard.press("Enter");
await page.waitForFunction(() => window.__ml?.nightShader?.() === true, null, { timeout: 20000 });
await page.waitForTimeout(1500);
await page.evaluate(() => window.__ml.timeOfDay("Day"));
const shot = async () => { await page.waitForTimeout(400); return PNG.sync.read(await page.screenshot()); };
const { writeFileSync } = await import("fs");
await page.evaluate(() => window.__ml.groundWarp(6, 0.02, false));
const off = await shot(); writeFileSync(`${SP}/gw_off.png`, PNG.sync.write(off));
const info = await page.evaluate(() => window.__ml.groundWarp(6, 0.02, true));
console.log("warpInfo:", JSON.stringify(info));
const on = await shot(); writeFileSync(`${SP}/gw_on.png`, PNG.sync.write(on));
// diff over a ground band (avoid HUD bottom + right, and the character column)
let sum=0,n=0,changed=0; for (let y=80;y<380;y+=2) for (let x=80;x<1480;x+=2){ if(x>720&&x<900&&y>150)continue; const i=(y*off.width+x)*4; const d=Math.abs(off.data[i]-on.data[i])+Math.abs(off.data[i+1]-on.data[i+1])+Math.abs(off.data[i+2]-on.data[i+2]); sum+=d; n++; if(d>18)changed++; }
console.log(`ground band: meanDiff ${(sum/n).toFixed(2)}, changedPct ${(100*changed/n).toFixed(1)}%`);
await browser.close();
