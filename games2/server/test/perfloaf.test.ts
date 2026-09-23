// WHERE A LONG FRAME'S TIME WENT (client/src/perfloaf.ts): the browser's
// long-animation-frame timestamps split into the tasks that ran BEFORE the
// rendering update, the rAF callbacks (our frame) and style/layout/paint —
// and the invokers named. Plus the two pure helpers the GL counters and the
// group census are built on (client/src/perfextra.ts).
import { test } from "node:test";
import assert from "node:assert/strict";
import { loafSplit, invokerName } from "../../client/src/perfloaf";
import { triFillPx, sectionGroup } from "../../client/src/perfextra";

test("a long frame splits into pre (tasks first), raf (our frame) and dom (style/layout/paint)", () => {
  const s = loafSplit({
    startTime: 1000,
    duration: 90,
    renderStart: 1030,
    styleAndLayoutStart: 1080,
    blockingDuration: 40,
    scripts: [
      { invoker: "WebSocket.onmessage", duration: 28 },
      { invoker: "FrameRequestCallback", duration: 48, forcedStyleAndLayoutDuration: 2.5 },
      { invoker: "WebSocket.onmessage", duration: 1.5 },
    ],
  });
  assert.equal(s.t0, 1000);
  assert.equal(s.t1, 1090);
  assert.equal(s.ms, 90);
  assert.equal(s.pre, 30, "before renderStart: the socket patch ran ahead of the frame");
  assert.equal(s.raf, 50, "renderStart to styleAndLayoutStart: the rAF callbacks");
  assert.equal(s.dom, 10, "the rest is style, layout, paint and commit");
  assert.equal(s.block, 40);
  assert.equal(s.forced, 2.5);
  // Invokers summed and ordered longest first: the frame, then the socket.
  assert.deepEqual(s.by, [["FrameRequestCallback", 48], ["WebSocket.onmessage", 29.5]]);
});

test("no rendering update inside the entry means the whole duration was tasks", () => {
  const s = loafSplit({ startTime: 5, duration: 70, renderStart: 0, styleAndLayoutStart: 0 });
  assert.deepEqual([s.pre, s.raf, s.dom], [70, 0, 0]);
  // Rendering began but style/layout never did: the rest after renderStart is rAF.
  const r = loafSplit({ startTime: 0, duration: 60, renderStart: 20 });
  assert.deepEqual([r.pre, r.raf, r.dom], [20, 40, 0]);
});

test("an invoker name is the API, not the element or the whole URL, and it is bounded", () => {
  assert.equal(invokerName({ invoker: "BUTTON#ml-settings.onclick" }), "BUTTON.onclick");
  assert.equal(invokerName({ invoker: "IMG[src=blob:http://nangijala.online/e7fd7].onload" }), "IMG.onload");
  assert.equal(invokerName({ invoker: "IMG[src=blob:http://localhost:2567/e7fd7" }), "IMG", "the browser truncates the attribute itself");
  assert.equal(invokerName({ invoker: "TimerHandler:setTimeout" }), "TimerHandler:setTimeout");
  assert.equal(invokerName({ sourceURL: "https://nangijala.online/assets/index-abc123.js" }), "index-abc123.js");
  assert.equal(invokerName({ invokerType: "classic-script" }), "classic-script");
  assert.equal(invokerName({}), "?");
  assert.equal(invokerName({ invoker: "x".repeat(100) }).length, 40);
  // At most six invokers ride along, longest first.
  const many = loafSplit({ startTime: 0, duration: 100, scripts: Array.from({ length: 9 }, (_, i) => ({ invoker: `inv${i}`, duration: i + 1 })) });
  assert.equal(many.by.length, 6);
  assert.equal(many.by[0][0], "inv8");
});

test("triFillPx sums the area of every triangle in a batch, at the shader's stride and offset", () => {
  // Two triangles making a 100x50 quad, in a 7-float vertex (Phaser's multi
  // pipeline: position, texcoord, texid, tinteffect, tint) with a 2-float
  // prefix to prove the offset is honoured. Layout: v0 v1 v2 v0 v2 v3.
  const stride = 7;
  const posOff = 2;
  const quad = [
    [0, 0],
    [0, 50],
    [100, 50],
    [0, 0],
    [100, 50],
    [100, 0],
  ];
  const view = new Float32Array(stride * 6);
  quad.forEach(([x, y], i) => {
    view[i * stride + posOff] = x;
    view[i * stride + posOff + 1] = y;
  });
  assert.equal(triFillPx(view, 6, stride, posOff), 5000);
  // A lone triangle (a Graphics fill) counts on its own; a dangling vertex does not.
  assert.equal(triFillPx(view, 3, stride, posOff), 2500);
  assert.equal(triFillPx(view, 4, stride, posOff), 2500);
  // Winding does not matter: area is unsigned.
  const rev = new Float32Array(stride * 3);
  [[0, 0], [100, 50], [0, 50]].forEach(([x, y], i) => {
    rev[i * stride + posOff] = x;
    rev[i * stride + posOff + 1] = y;
  });
  assert.equal(triFillPx(rev, 3, stride, posOff), 2500);
});

test("the section groups name what KIND of work a frame did", () => {
  assert.equal(sectionGroup("groundSlice"), "ground");
  assert.equal(sectionGroup("repaintCells"), "ground");
  assert.equal(sectionGroup("rebuildOccluders"), "occ");
  assert.equal(sectionGroup("coverIndex"), "occ");
  assert.equal(sectionGroup("litCoverSurf"), "light");
  assert.equal(sectionGroup("litSomethingNew"), "light", "a lit* section added later is still light");
  assert.equal(sectionGroup("monsterLoop"), "sim");
  assert.equal(sectionGroup("depthSort"), "render");
  assert.equal(sectionGroup("glEnd"), "gl");
  assert.equal(sectionGroup("preUpdate"), "engine");
  assert.equal(sectionGroup("hooks"), "hooks");
  assert.equal(sectionGroup("gapBusy"), "busy");
  assert.equal(sectionGroup("gapIdle"), "idle");
  assert.equal(sectionGroup("somethingElse"), "misc");
});
