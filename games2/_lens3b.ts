import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Tiles3, viewFromDoc, hexRGB, TILE, PLATE_H, TOP_Y, DX, DY, columnX, columnY } from "./client/src/tiles3";
import { patternSheets, patternSheetPaths, composeBoundary, conformPlate, topFaceOnly,
  cellOps, boundaryOp, plateKey, boundaryKeyFor, artKey, liquidDiamond, liquidKey,
  type Pixels, type PatternSheets } from "./client/src/tiles3draw";
// @ts-expect-error
import { imgRGBA } from "./scripts/imagelib.mjs";
const REPO = "/home/user/pixel";
const rel = (p: string) => join(REPO, p);
const load = (p: string): any => JSON.parse(readFileSync(rel(p), "utf8"));
const px = (p: string): Pixels => { const i = imgRGBA(rel(p)) as any; return { w: i.width, h: i.height, data: new Uint8ClampedArray(i.data) }; };
const PAT = load("tiles/patterns/index.json"); const sp = patternSheetPaths(PAT);
const SHEETS: PatternSheets = patternSheets(PAT, px(sp.silhouette), px(sp.masks), px(sp.border));
const GT = load("tiles/ground_types.json").grounds;
const wallRGB = (g: string): [number,number,number] => hexRGB(GT[g].palette.wall);
const t = new Tiles3({ baseTileSets: load("live/tuning/base_tile_sets.json"), memberResolve: load("tiles/resolve.json"),
  groundTypes: GT, patterns: PAT, review: load("tiles/review/manifest.json"), feedback: load("live/feedback/tiles.json").entries,
  wallOverrides: load("live/tuning/tile_walls.json").overrides, basePromotions: load("live/tuning/base_tiles.json").overrides,
  fades: load("tiles/fades/index.json"), slopes: load("tiles/slopes/index.json"),
  topWallOverrides: load("live/tuning/top_walls.json").overrides, topOverrides: load("live/tuning/tile_tops.json").overrides,
  storeyPitch: 15, warn: () => {} } as any);
const doc = load("maps2/worlds3/the_game/world.json");
const ARG = process.argv[2] ?? "444,362,477,395";
const [X0,Y0,X1,Y1] = ARG.split(",").map(Number);
const win = t.resolveWindow(viewFromDoc(doc, { x0:X0, y0:Y0, x1:X1, y1:Y1 }));
const tex = new Map<string, Pixels>();
function plateFor(art:any, ground:string){ const k=plateKey(art,ground); if(tex.has(k))return tex.get(k)!;
  let p:Pixels; if(art.kind==="liquid")p=liquidDiamond(art.topRGB,SHEETS); else { p=px(art.path);
  if(art.kind==="conform")p=conformPlate(SHEETS,p,wallRGB(ground)); if(art.topOnly)p=topFaceOnly(SHEETS,p);} tex.set(k,p); return p; }
for(const c of win.cells as any[]){ if(c.kind==="field"&&c.art){ if(c.art.kind==="liquid"){const k=liquidKey(c.art.topRGB); if(!tex.has(k))tex.set(k,liquidDiamond(c.art.topRGB,SHEETS));} else plateFor(c.art,c.ground);} 
  if(c.wall)for(const s of c.wall.stack)if(s.tile.path){const k=artKey(s.tile.path); if(!tex.has(k))tex.set(k,px(s.tile.path));}}
for(const d of win.decks as any[])for(const s of d.stack)if(s.tile.path){const k=artKey(s.tile.path); if(!tex.has(k))tex.set(k,px(s.tile.path));}
const bRaw=new Map<string,Pixels>(), bTop=new Map<string,Pixels>();
for(const b of win.boundaries as any[]){ const k=boundaryKeyFor(b); if(!k||bRaw.has(k))continue;
  const pa0=px(b.plateA.path), pb0=px(b.plateB.path);
  const pa=b.plateA.kind==="conform"?conformPlate(SHEETS,pa0,wallRGB(b.a)):pa0;
  const pbb=b.plateB.kind==="conform"?conformPlate(SHEETS,pb0,wallRGB(b.b)):pb0;
  const raw=composeBoundary(SHEETS,b.maskFrame,pa,pbb,{seam:true});
  bRaw.set(k,raw); bTop.set(k,topFaceOnly(SHEETS,raw,{margin:false})); }
type C={w:number;h:number;d:Uint8ClampedArray};
let minX=1e9,minY=1e9,maxX=-1e9,maxY=-1e9; const boxes:any[]=[];
for(const c of win.cells as any[])for(const o of cellOps(c))boxes.push(o);
for(const b of win.boundaries as any[]){const o=boundaryOp(b); if(o)boxes.push(o);}
for(const bx of boxes){minX=Math.min(minX,bx.x);minY=Math.min(minY,bx.y);maxX=Math.max(maxX,bx.x+bx.sw);maxY=Math.max(maxY,bx.y+bx.sh);}
const CW=maxX-minX, CH=maxY-minY; const newC=():C=>({w:CW,h:CH,d:new Uint8ClampedArray(CW*CH*4)});
function blit(cv:C,src:Pixels,dx:number,dy:number){const ox=dx-minX,oy=dy-minY;
  for(let y=0;y<src.h;y++){const cy=oy+y; if(cy<0||cy>=cv.h)continue;
    for(let x=0;x<src.w;x++){const cx=ox+x; if(cx<0||cx>=cv.w)continue;
      const si=(y*src.w+x)*4,a=src.data[si+3]; if(a===0)continue; const di=(cy*cv.w+cx)*4;
      if(a===255){cv.d[di]=src.data[si];cv.d[di+1]=src.data[si+1];cv.d[di+2]=src.data[si+2];cv.d[di+3]=255;}
      else{const al=a/255,ia=1-al; cv.d[di]=Math.round(src.data[si]*al+cv.d[di]*ia);cv.d[di+1]=Math.round(src.data[si+1]*al+cv.d[di+1]*ia);
        cv.d[di+2]=Math.round(src.data[si+2]*al+cv.d[di+2]*ia);cv.d[di+3]=Math.round(a+cv.d[di+3]*ia);}}}}
const getTex=(k:string)=>tex.get(k)??bRaw.get(k);
function game(top:boolean){const cv=newC();
  for(const c of win.cells as any[])for(const o of cellOps(c)){const s=getTex(o.key); if(s)blit(cv,s,o.x,o.y);}
  for(const b of win.boundaries as any[]){const o=boundaryOp(b); if(!o)continue; const s=(top?bTop:bRaw).get(o.key); if(s)blit(cv,s,o.x,o.y);}
  for(const d of win.decks as any[])for(const s0 of d.stack){const s=tex.get(artKey(s0.tile.path)); if(s)blit(cv,s,d.sx,s0.y);} return cv;}
function r3(){const cv=newC(); const byCell=new Map<string,any>();
  for(const b of win.boundaries as any[])byCell.set(`${b.x},${b.y}`,b);
  for(const c of win.cells as any[]){const b=byCell.get(`${c.x},${c.y}`);
    if(b&&c.kind==="field"){const o=boundaryOp(b); if(o){const s=bRaw.get(o.key); if(s){blit(cv,s,o.x,o.y); continue;}}}
    for(const o of cellOps(c)){const s=getTex(o.key); if(s)blit(cv,s,o.x,o.y);}}
  for(const d of win.decks as any[])for(const s0 of d.stack){const s=tex.get(artKey(s0.tile.path)); if(s)blit(cv,s,d.sx,s0.y);} return cv;}
const B=game(true), C=r3();
// locate the residual diffs, and attribute each to a boundary cell
const bnd = win.boundaries as any[];
const attr = new Map<string, number>();
const pts:Array<[number,number]>=[];
for(let yy=0;yy<CH;yy++)for(let xx=0;xx<CW;xx++){const i=yy*CW+xx; let d=false;
  for(let ch=0;ch<4;ch++)if(B.d[i*4+ch]!==C.d[i*4+ch]){d=true;break;} if(!d)continue;
  pts.push([xx,yy]);
  // which boundary box contains it?
  let hit="none";
  for(const b of bnd){const o=boundaryOp(b); if(!o)continue;
    const lx=xx+minX-o.x, ly=yy+minY-o.y;
    if(lx>=0&&lx<o.sw&&ly>=0&&ly<o.sh){ const li=ly*SHEETS.fw+lx;
      hit=`${b.x},${b.y} ${b.a}|${b.b} idx${b.index} region=${SHEETS.libTop[li]?"TOP":(SHEETS.libWall[li]?"WALL":"outside")} localY=${ly}`; break; }}
  attr.set(hit,(attr.get(hit)??0)+1);}
console.log(`residual AFTER-vs-render3: ${pts.length} texels`);
// are they at the frontier of the window? report min/max and whether the owning cell is on the window's front edge
const gx=(x:number)=>x+minX, gy=(y:number)=>y+minY;
const xs=pts.map(p=>gx(p[0])), ys=pts.map(p=>gy(p[1]));
if(pts.length){console.log(`  bbox x ${Math.min(...xs)}..${Math.max(...xs)}  y ${Math.min(...ys)}..${Math.max(...ys)}`);}
const ent=[...attr.entries()].sort((a,b)=>b[1]-a[1]);
for(const [k,v] of ent.slice(0,20))console.log(`   ${v.toString().padStart(5)}  ${k}`);
// classify by region
let inTop=0,inWall=0,outside=0,none=0;
for(const [k,v] of ent){ if(k==="none")none+=v; else if(k.includes("region=TOP"))inTop+=v; else if(k.includes("region=WALL"))inWall+=v; else outside+=v; }
console.log(`  by region: TOP=${inTop} WALL=${inWall} outside-silhouette=${outside} no-boundary-box=${none}`);
// FRONT-EDGE test: is every differing texel owned by a cell on the window's front frontier?
const onEdge = new Set<string>();
for(const b of bnd){ if(b.x===X1-1||b.y===Y1-1||b.x===X0||b.y===Y0) onEdge.add(`${b.x},${b.y}`); }
let edgeN=0, interiorN=0; const interiorCells=new Set<string>();
for(const [k,v] of ent){ if(k==="none"){interiorN+=v; continue;} const cell=k.split(" ")[0];
  if(onEdge.has(cell))edgeN+=v; else {interiorN+=v; interiorCells.add(cell);} }
console.log(`  ${edgeN} texels belong to a boundary on the WINDOW FRONTIER, ${interiorN} to an interior boundary`);
if(interiorCells.size)console.log(`  interior boundary cells implicated: ${[...interiorCells].join(" ")}`);
