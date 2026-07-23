#!/usr/bin/env python3
"""Split the maintainer's 2x analog-stick art into TOP (cap+shaft) and BASE.

Source: client/ui-src/gamepad/stick2-source.png — the 128x128 redraw
(2026-07-23, "twice as big so we can render it without upscale"): mushroom
cap on a visible SHAFT standing in a dished socket. Binary alpha, no
backdrop to key.

The MOVING piece is the mushroom CAP ALONE — round 2 of his marks
(2026-07-23, "You cut the graphics wrong. The red should have been the
cut"): the red line runs along the cap's underside, so the SHAFT stays
with the socket. (The green mark on the same screenshot flagged the 1px
transparent slit of the FIRST preview in the work log — already healed by
the median pass below; the shipped tiles never had it.)

Where cap and socket meet everything is near-black, so the split walks
each column:

  cap columns (topmost opaque row <= CAP_T): skip the dome's own top
  outline, run through the cap body (median-smoothed against face-speck
  false stops), then keep at most CAP_EDGE rows of the underside outline
  run — deeper black is the socket-hole edge BEHIND the cap and stays
  with the base (it lands in the Gemini hole anyway).

Everything else — dish, hole, AND the shaft standing in it — is the base
tile; the Gemini fill only has to invent what the cap occludes (the dish
back rim and the shaft's top).

Outputs (same canvas, so the pieces stack 1:1 like the first-gen split):
  client/ui-src/gamepad/stick2-top.png          the moving cap
  client/ui-src/gamepad/stick2-base-holed.png   shaft + socket, cap hole
  client/public/ui2/pad-stick2-top.png          the cap, published in-game
Invariant: top ∪ base == source, byte-exact, zero overlap (asserted).
"""

from PIL import Image

SRC = "client/ui-src/gamepad/stick2-source.png"
TOP = "client/ui-src/gamepad/stick2-top.png"
PUB_TOP = "client/public/ui2/pad-stick2-top.png"
BASE = "client/ui-src/gamepad/stick2-base-holed.png"

BLACK_V = 22      # mean-luma below this = outline black
CAP_T = 58        # columns whose art starts above this row carry the cap
CAP_EDGE = 2      # underside outline rows the cap keeps per column


def main():
    im = Image.open(SRC).convert("RGBA")
    W, H = im.size
    p = im.load()
    lum = lambda c: (c[0] + c[1] + c[2]) / 3
    black = lambda c: c[3] > 0 and lum(c) < BLACK_V

    cap_cols = []
    tops = {}
    for x in range(W):
        rows = [y for y in range(H) if p[x, y][3]]
        if rows and rows[0] <= CAP_T:
            cap_cols.append(x)
            tops[x] = rows[0]

    def walk(x, ignore_black_above):
        """Walk one cap column; black runs that END above the given row are
        cap-face detail (specks, creases), not the underside outline.
        Returns (last cap row inclusive, rows marked)."""
        y = tops[x]
        marked = []
        while y < H and black(p[x, y]):  # the dome's own top outline
            marked.append(y)
            y += 1
        while y < H and p[x, y][3]:
            if not black(p[x, y]):
                marked.append(y)
                y += 1
                continue
            run = 0
            while y + run < H and black(p[x, y + run]):
                run += 1
            if y + run - 1 < ignore_black_above and y + run < H and p[x, y + run][3]:
                for yy in range(y, y + run):  # face speck — swallow it
                    marked.append(yy)
                y += run
                continue
            # the underside outline: keep at most CAP_EDGE rows of it
            for yy in range(y, min(y + run, y + CAP_EDGE)):
                marked.append(yy)
            return marked[-1], marked
        return marked[-1], marked

    # pass 1: naive walk (no speck tolerance) → cap-bottom estimate
    bot0 = {x: walk(x, 0)[0] for x in cap_cols}
    # pass 2: the cap is convex — its bottom contour is smooth. A column
    # that stopped far above its neighbours' median hit a dark FACE SPECK
    # (the 1px slit bug); re-walk it treating black runs above the local
    # consensus as body detail.
    final_rows = {}
    for x in cap_cols:
        near = sorted(bot0[nx] for nx in cap_cols if abs(nx - x) <= 3)
        med = near[len(near) // 2]
        if bot0[x] < med - 4:
            _, marked = walk(x, med - 4)
        else:
            _, marked = walk(x, 0)
        final_rows[x] = marked

    top = [[False] * W for _ in range(H)]
    for x in cap_cols:
        for y in final_rows[x]:
            top[y][x] = True
        # the SHAFT below the cap boundary stays with the base ("the red
        # should have been the cut") — nothing more to mark here

    # sweep: a tiny stranded island (the cap tips' outline crumbs — nothing
    # sits behind the tips, so "deeper black -> base" leaves floating dots)
    # belongs with the piece it touches. Both pieces must end up as ONE
    # connected region each.
    def components(pred):
        seen = set()
        comps = []
        for y0 in range(H):
            for x0 in range(W):
                if (x0, y0) in seen or not pred(x0, y0):
                    continue
                comp = [(x0, y0)]
                seen.add((x0, y0))
                qi = 0
                while qi < len(comp):
                    cx, cy = comp[qi]
                    qi += 1
                    for dx in (-1, 0, 1):
                        for dy in (-1, 0, 1):
                            nx, ny = cx + dx, cy + dy
                            if (0 <= nx < W and 0 <= ny < H and (nx, ny) not in seen
                                    and pred(nx, ny)):
                                seen.add((nx, ny))
                                comp.append((nx, ny))
                comps.append(comp)
        return comps

    opaque = lambda x, y: p[x, y][3] > 0
    for flag in (False, True):  # False: base islands -> top; True: reverse
        pred = (lambda x, y: opaque(x, y) and top[y][x] == flag)
        comps = sorted(components(pred), key=len)
        for comp in comps[:-1]:  # everything but the main region
            assert len(comp) <= 6, f"unexpected large stray ({len(comp)} px, top={flag})"
            for x, y in comp:
                top[y][x] = not flag
    n_top = len(components(lambda x, y: opaque(x, y) and top[y][x]))
    n_base = len(components(lambda x, y: opaque(x, y) and not top[y][x]))
    assert n_top == 1 and n_base == 1, f"pieces not connected: top={n_top} base={n_base}"

    top_im = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    base_im = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    tp, bp = top_im.load(), base_im.load()
    for y in range(H):
        for x in range(W):
            if not p[x, y][3]:
                continue
            (tp if top[y][x] else bp)[x, y] = p[x, y]
    top_im.save(TOP)
    top_im.save(PUB_TOP)
    base_im.save(BASE)

    # byte-exact partition
    for y in range(H):
        for x in range(W):
            s, t, b = p[x, y], tp[x, y], bp[x, y]
            have = t if t[3] else b
            assert not (t[3] and b[3]), f"overlap at {(x, y)}"
            assert (s[3] == 0 and have[3] == 0) or have == s, f"mismatch at {(x, y)}"
    print(f"split OK: top bbox {top_im.getbbox()}, base bbox {base_im.getbbox()}")
    print(f"top px {sum(1 for y in range(H) for x in range(W) if tp[x, y][3])}, "
          f"base px {sum(1 for y in range(H) for x in range(W) if bp[x, y][3])}")


if __name__ == "__main__":
    main()
