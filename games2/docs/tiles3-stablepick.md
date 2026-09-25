# A stable base-tile pick (bts2) — the port, the vectors, the flip

**Status: proposed, implemented inert in `games2`, NOT wired in.** The rule
lives in three domains and may not change in one of them.

## What is wrong

The pick is **deterministic** and always has been — 100% identical on a re-roll,
and there is no `Math.random` anywhere in `tiles3.ts` or `render3.py`. It has
never been **stable**: `pickWeighted` walks a cumulative whose TOTAL moves when
the member list changes, so every bucket boundary shifts at once.

Measured (`games2/server/test/pickstable.test.ts`, 40,000 cells):

| change to a 6-member set | cells keeping their tile |
|---|---|
| none — the same data re-rolled | **100.0%** |
| add a 7th member | **50.5%** |
| one member's weight +20% | **91.9%** |

The maintainer edits these sets LIVE from the wiki
(`live/tuning/base_tile_sets.json`), so adding one tile re-tiles half the world
under him — and a wiki REJECT is a removal, because a verdict filters the pool.
That is what he reported on 2026-09-25.

## The rule that replaces it

Weighted **rendezvous hashing**: hash each MEMBER against the cell and keep the
best score. No member's score depends on any other, so adding a member can only
take the cells it wins and removing one only releases the cells it had.

| | keeping their tile |
|---|---|
| add a 7th member | **85.9%** (optimum 85.7%) |
| one member's weight +20% | **97.2%** |
| remove a member | every cell that did not hold it: **0 moved** |

Weight-proportionality and the meaning of weight 0 (never) are unchanged.

## Why it is integer-only

Rendezvous with weights wants `u^(1/w)`. Two things rule out the obvious forms:

- **Member weights are fractional** — 0.05, 0.1, 0.2, 0.3, 0.5, 0.6, 0.8 … 30,
  measured off the live file. So "replicate each member w times" would cost
  thousands of hashes per cell and break on the next finer weight.
- **`Math.pow`/`Math.log` are not bit-identical across runtimes.** V8 uses its
  own fdlibm port; CPython calls the platform libm. They may differ in the last
  ulp. `render3.py` IS the spec and the parity fixture holds `tiles3.ts` equal
  to it CELL FOR CELL, so a last-ulp disagreement is one wrong tile somewhere in
  the world, someday, with nothing to blame it on.

So the score is a hand-rolled **Q16.16 log2** over the FNV hash, compared by
cross-multiplication in integers. Every operation is exact in both runtimes:
the squaring keeps `x` under 2^18 so `x*x` is under 2^36, and the comparison
products stay under 2^36 — both exact in a JS double and in a Python int.
**Proven bit-identical over 4,000 rows.**

Maximising `u^(1/w)` is minimising `(-log2 u)/w`; with `L = 32*65536 -
log2fx(hash)` that is minimising `L/W`, compared as `L_i*W_j < L_j*W_i` so there
is no division either. An exact tie falls to the smaller key, so the answer
never depends on the order members arrive in.

## The port — Python, for `maps2/pipeline/render3.py`

```python
def log2fx(h):
    """log2 of a 32-bit value in Q16.16, integer only. Matches tiles3.ts."""
    h &= 0xffffffff
    if h == 0:
        return 0
    e = 0
    v = h
    while v > 1:
        v >>= 1
        e += 1
    x = (h >> (e - 16)) if e >= 16 else (h << (16 - e))
    frac = 0
    for i in range(1, 17):
        x = (x * x) // 65536
        if x >= 131072:
            x //= 2
            frac |= 1 << (16 - i)
    return e * 65536 + frac

WEIGHT_SCALE = 1000

def pick_stable(keys, weights, cell):
    """Stable weighted pick. -1 when nothing is pickable, as pick_weighted."""
    best, bL, bW = -1, 0, 0
    for i, k in enumerate(keys):
        W = round(weights[i] * WEIGHT_SCALE)
        if W <= 0:
            continue                      # 0 still means never
        L = 32 * 65536 - log2fx(fnv1a(f"{cell}|{k}"))
        if best < 0:
            best, bL, bW = i, L, W
            continue
        a, b = L * bW, bL * W
        if a < b or (a == b and k < keys[best]):
            best, bL, bW = i, L, W
    return best
```

Call site, replacing the `bts1|tile` pick:

```python
# was: i = pick_weighted([m["weight"] for m in mem],
#                        unit_hash(f"bts1|tile|{chosen['id']}|{x}|{y}"))
i = pick_stable([member_key(m) for m in mem],
                [m["weight"] for m in mem],
                f"bts2|tile|{chosen['id']}|{x}|{y}")
```

`member_key(m)` must be the member's STABLE identity — the same string the other
two implementations use, and never its index. Use the verdict key the review
already keys a member by (`tiles3.ts` `memberKey`); if the three disagree on
that string they disagree on the world.

The same applies to the `wr1|tile` wall-region pick at `render3.py:903`, which
has the identical instability.

## The port — JS, for `wiki/lib/basesets.mjs`

Identical to `games2/client/src/tiles3.ts` `log2fx` / `pickStable` / 
`WEIGHT_SCALE`; copy them verbatim. `wiki/site/wiki.js` and the three
`wiki/tools/*.mjs` consume `basesets.mjs`, so they follow.

## Vectors — a port that misses one of these misses the world

```
log2fx(0)          = 0            log2fx(65535)     = 1048574
log2fx(1)          = 0            log2fx(0xdeadbeef)= 2083966
log2fx(2)          = 65536        log2fx(0xffffffff)= 2097151
log2fx(3)          = 103872       log2fx(255)       = 523917
```

With keys `m0..m5` and weights `[1, 2, 4, 0.5, 0.1, 0.05]`:

```
pick_stable(..., "grass|0|0") = 2
pick_stable(..., "grass|1|0") = 2
pick_stable(..., "grass|7|3") = 1
```

`fnv1a` is unchanged: `fnv1a("bts1|tile|1|0|0") == 1995477220`.

## The flip

1. `maps2` lands `pick_stable` in `render3.py` (the spec) — both `bts1|tile` and
   `wr1|tile`.
2. `wiki` lands it in `basesets.mjs`.
3. `games2` wires it into the resolver and regenerates the parity fixture.
4. The namespace goes `bts1|` → `bts2|` in all three **in the same push window**.

Steps 1–3 in any order; step 4 only when all three carry it. Flipping one of
three is what the parity law forbids, and `pickstable.test.ts` arm 6 goes red if
`games2` does it alone.

**The changeover re-tiles the world ONCE** — every cell re-rolls against the new
namespace. That is unavoidable and it is the last time it happens: after it,
adding or rejecting a tile moves only the cells that tile wins or held.
