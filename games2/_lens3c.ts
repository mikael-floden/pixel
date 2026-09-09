import { readFileSync } from "node:fs"; import { join } from "node:path";
import { Tiles3, viewFromDoc, hexRGB } from "./client/src/tiles3";
import { patternSheets, patternSheetPaths, composeBoundary, conformPlate, topFaceOnly,
  cellOps, boundaryOp, plateKey, boundaryKeyFor, artKey, liquidDiamond, liquidKey,
  type Pixels, type PatternSheets } from "./client/src/tiles3draw";
// @ts-expect-error
import { imgRGBA } from "./scripts/imagelib.mjs";
const REPO="/home/user/pixel"; const rel=(p:string)=>join(REPO,p);
const load=(p:string):any=>JSON.parse(readFileSync(rel(p),"utf8"));
const px=(p:string):Pixels=>{const i=imgRGBA(rel(p)) as any; return {w:i.width,h:i.height,data:new Uint8ClampedArray(i.data)};};
const PAT=load("tiles/patterns/index.json"); const sp=patternSheetPaths(PAT);
const SHEETS:PatternSheets=patternSheets(PAT,px(sp.silhouette),px(sp.masks),px(sp.border));
const GT=load("tiles/ground_types.json").grounds;
const wallRGB=(g:string):[number,number,number]=>hexRGB(GT[g].palette.wall);
const t=new Tiles3({baseTileSets:load("live/tuning/base_tile_sets.json"),memberResolve:load("tiles/resolve.json"),
  groundTypes:GT,patterns:PAT,review:load("tiles/review/manifest.json"),feedback:load("live/feedback/tiles.json").entries,
  wallOverrides:load("live/tuning/tile_walls.json").overrides,basePromotions:load("live/tuning/base_tiles.json").overrides,
  fades:load("tiles/fades/index.json"),slopes:load("tiles/slopes/index.json"),
  topWallOverrides:load("live/tuning/top_walls.json").overrides,topOverrides:load("live/tuning/tile_tops.json").overrides,
  storeyPitch:15,warn:()=>{}} as any);
const doc=load("maps2/worlds3/the_game/world.json");
const [X0,Y0,X1,Y1]=(process.argv[2]??"444,362,477,395").split(",").map(Number);
const win=t.resolveWindow(viewFromDoc(doc,{x0:X0,y0:Y0,x1:X1,y1:Y1}));
const tex=new Map<string,Pixels>();
function plateFor(art:any,g:string){const k=plateKey(art,g); if(tex.has(k))return tex.get(k)!;
  let p:Pixels; if(art.kind==="liquid")p=liquidDiamond(art.topRGB,SHEETS); else {p=px(art.path);
  if(art.kind==="conform")p=conformPlate(SHEETS,p,wallRGB(g)); if(art.topOnly)p=topFaceOnly(SHEETS,p);} tex.set(k,p); return p;}
for(const c of win.cells as any[]){if(c.kind==="field"&&c.art){if(c.art.kind==="liquid"){const k=liquidKey(c.art.topRGB); if(!tex.has(k))tex.set(k,liquidDiamond(c.art.topRGB,SHEETS));}else plateFor(c.art,c.ground);}
  if(c.wall)for(const s of c.wall.stack)if(s.tile.path){const k=artKey(s.tile.path); if(!tex.has(k))tex.set(k,px(s.tile.path));}}
for(const d of win.decks as any[])for(const s of d.stack)if(s.tile.path){const k=artKey(s.tile.path); if(!tex.has(k))tex.set(k,px(s.tile.path));}
const bRaw=new Map<string,Pixels>(),bTop=new Map<string,Pixels>();
for(const b of win.boundaries as any[]){const k=boundaryKeyFor(b); if(!k||bRaw.has(k))continue;
  const pa0=px(b.plateA.path),pb0=px(b.plateB.path);
  const pa=b.plateA.kind==="conform"?conformPlate(SHEETS,pa0,wallRGB(b.a)):pa0;
  const pbb=b.plateB.kind==="conform"?conformPlate(SHEETS,pb0,wallRGB(b.b)):pb0;
  const raw=composeBoundary(SHEETS,b.maskFrame,pa,pbb,{seam:true});
  bRaw.set(k,raw); bTop.set(k,topFaceOnly(SHEETS,raw,{margin:false}));}
type C={w:number;h:number;d:Uint8ClampedArray};
let minX=1e9,minY=1e9,maxX=-1e9,maxY=-1e9; const boxes:any[]=[];
for(const c of win.cells as any[])for(const o of cellOps(c))boxes.push(o);
for(const b of win.boundaries as any[]){const o=boundaryOp(b); if(o)boxes.push(o);}
for(const bx of boxes){minX=Math.min(minX,bx.x);minY=Math.min(minY,bx.y);maxX=Math.max(maxX,bx.x+bx.sw);maxY=Math.max(maxY,bx.y+bx.sh);}
const CW=maxX-minX,CH=maxY-minY; const newC=():C=>({w:CW,h:CH,d:new Uint8ClampedArray(CW*CH*4)});
function blit(cv:C,src:Pixels,dx:number,dy:number){const ox=dx-minX,oy=dy-minY;
  for(let y=0;y<src.h;y++){const cy=oy+y; if(cy<0||cy>=cv.h)continue;
    for(let x=0;x<src.w;x++){const cx=ox+x; if(cx<0||cx>=cv.w)continue;
      const si=(y*src.w+x)*4,a=src.data[si+3]; if(a===0)continue; const di=(cy*cv.w+cx)*4;
      if(a===255){cv.d[di]=src.data[si];cv.d[di+1]=src.data[si+1];cv.d[di+2]=src.data[si+2];cv.d[di+3]=255;}
      else{const al=a/255,ia=1-al;cv.d[di]=Math.round(src.data[si]*al+cv.d[di]*ia);cv.d[di+1]=Math.round(src.data[si+1]*al+cv.d[di+1]*ia);
      cv.d[di+2]=Math.round(src.data[si+2]*al+cv.d[di+2]*ia);cv.d[di+3]=Math.round(a+cv.d[di+3]*ia);}}}}
const getTex=(k:string)=>tex.get(k)??bRaw.get(k);
const byCell=new Map<string,any>(); for(const b of win.boundaries as any[])byCell.set(`${b.x},${b.y}`,b);
/* SEPARATE PASS (the game): all cells, then all boundaries */
function sep(map:Map<string,Pixels>):C{const cv=newC();
  for(const c of win.cells as any[])for(const o of cellOps(c)){const s=getTex(o.key); if(s)blit(cv,s,o.x,o.y);}
  for(const b of win.boundaries as any[]){const o=boundaryOp(b); if(!o)continue; const s=map.get(o.key); if(s)blit(cv,s,o.x,o.y);}
  for(const d of win.decks as any[])for(const s0 of d.stack){const s=tex.get(artKey(s0.tile.path)); if(s)blit(cv,s,d.sx,s0.y);} return cv;}
/* INTERLEAVED (render3): per cell, plate then boundary over it, at the cell's turn */
function inter(map:Map<string,Pixels>):C{const cv=newC();
  for(const c of win.cells as any[]){for(const o of cellOps(c)){const s=getTex(o.key); if(s)blit(cv,s,o.x,o.y);}
    const b=byCell.get(`${c.x},${c.y}`); if(b&&c.kind==="field"){const o=boundaryOp(b); if(o){const s=map.get(o.key); if(s)blit(cv,s,o.x,o.y);}}}
  for(const d of win.decks as any[])for(const s0 of d.stack){const s=tex.get(artKey(s0.tile.path)); if(s)blit(cv,s,d.sx,s0.y);} return cv;}
function diff(p:C,q:C):{n:number;set:Set<number>}{let n=0; const s=new Set<number>();
  for(let i=0;i<p.w*p.h;i++){for(let ch=0;ch<4;ch++)if(p.d[i*4+ch]!==q.d[i*4+ch]){n++;s.add(i);break;}} return {n,set:s};}
const SEP_RAW=sep(bRaw), SEP_TOP=sep(bTop), INT_RAW=inter(bRaw), INT_TOP=inter(bTop);
console.log(`window ${X0}..${X1}x${Y0}..${Y1}  ${win.cells.length} cells / ${win.boundaries.length} boundaries`);
const d1=diff(SEP_RAW,INT_RAW), d2=diff(SEP_TOP,INT_RAW), d3=diff(SEP_TOP,INT_TOP), d4=diff(SEP_RAW,SEP_TOP);
console.log(`BEFORE the fix   vs render3 (interleaved, raw) : ${d1.n}`);
console.log(`AFTER  the fix   vs render3 (interleaved, raw) : ${d2.n}   <-- the parity number`);
console.log(`AFTER  the fix   vs SAME art, interleaved      : ${d3.n}   <-- PURE pass-separation artifact`);
console.log(`the fix's own footprint (BEFORE vs AFTER)      : ${d4.n}`);
// is the parity residual EXACTLY the pass-separation artifact?
let sub=0; for(const i of d2.set) if(!d3.set.has(i)) sub++;
let sup=0; for(const i of d3.set) if(!d2.set.has(i)) sup++;
console.log(`residual(AFTER vs render3) \\ pass-separation artifact = ${sub} texels`);
console.log(`pass-separation artifact \\ residual                   = ${sup} texels`);
// and the same for BEFORE: how much of BEFORE's divergence was pass separation?
let sub1=0; for(const i of d1.set) if(!d3.set.has(i)) sub1++;
console.log(`BEFORE's divergence NOT explained by pass separation  = ${sub1} texels`);
