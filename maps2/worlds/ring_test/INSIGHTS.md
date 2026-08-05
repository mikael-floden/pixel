# Terrain Transition Insights — tiles2 Ring Test → Production Map

## 1. Ranked transitions (best → worst)

| # | Transition | Rating | Verdict |
|---|-----------|:------:|---------|
| 1 | grass ↔ water (shore) | 4 | Most convincing border on the map — marshy reed/puddle shore; ship after breaking the "string-of-beads" puddle repetition. |
| 2 | grass ↔ dirt | 4 | Vegetation encroaching bare earth — the single most forgiving pair; shippable as-is. |
| 3 | dirt ↔ stone (scree) | 4 | Physically-motivated rubble band; strongest non-shore transition. Keep stone on the up-slope side. |
| 4 | snow ↔ water (shore) | 4 | Ragged ice/foam coast with a real surf curl; safe, just vary puddle/pebble stamps. |
| 5 | stone ↔ water (shore) | 4 | Rip-rap boulder coast; safe, add spike-rock variants so long runs don't picket-fence. |
| 6 | dirt ↔ water (shore) | 4 | Believable mudflat; safe. Soften blob outlines and trim the inland water pools (read as hazards). |
| 7 | black volcanic ↔ water (shore) | 4 | Evocative lava coast (keep the lava flecks); safe only if you standardize the tight fringe and cap the salt-and-pepper scatter. |
| 8 | snow ↔ saturated_grass | 4 | Convincing snowmelt; safe on **flat, organic** borders — the white/green contrast punishes straight runs. |
| 9 | black volcanic ↔ snow | 3 | **Risky.** Near-black/near-white clash with a hard seam stripe; feature-edge only, needs a wide ash band or intermediate. |
| 10 | stone_mountain ↔ black volcanic | 2 | **Avoid.** ~70% value cliff reads as a shadow-staircase/chasm; never place direct. |

## 2. Safe adjacencies (place directly, no intermediate terrain)

All rating-4 pairs are production-safe as neighbors:

- **grass ↔ dirt** — flat, direct, most forgiving.
- **dirt ↔ stone** — direct via scree; requires stone kept on the higher/harder side.
- **snow ↔ grass** — direct, but flat + organic only (see §3).
- **All four land ↔ water shores** (grass, dirt, stone, black volcanic) and **snow ↔ water** — shore adjacencies are the most reliable category on the map; every one rated 4.

These need only motif-variation polish, not layout intervention.

## 3. Needs care

- **snow ↔ saturated_grass** — no intermediate needed, but **constrain it**: keep on a single flat plane (never across a terrace step — the melt-blob read breaks on a slope), and prefer **long, organic** borders over short straight runs where blob repetition and the high white-on-green contrast show. Push a few snow flecks past the upper edge to dissolve the patchy→solid snowline.
- **black volcanic ↔ water** — safe but **inconsistent band width** is the risk. Standardize on the tight ~2-cell rocky fringe; **cap/drop the wide salt-and-pepper scatter cells** (they read as dithering noise, not shore). Keep the lava-fleck waterline.
- **black volcanic ↔ snow (the rating-3)** — treat as a **deliberate feature edge, not a general biome border**. If used direct, widen the ash-scatter to **4–5 cells**, heavily randomize debris so it never lines up, and **kill the hard black seam outline**. Better: step it down with an **intermediate ash-grey / dark-stone terrace** so value descends gradually. Use sparingly (e.g. a single "volcano rising from snow" beat).

## 4. Avoid / hardest

- **stone_mountain ↔ black volcanic (rating 2) — do not place directly.** The ~70% brightness drop makes any one-sided feather read as a shadow-cliff, and the border landing on a terrace edge doubles it (cliff + colour change on the same line = chasm).
  - **World-layout rule:** always separate bright stone and black volcanic with an intermediate terrain — **mid-grey scorched rock, ash, or dark gravel** — so the eye steps down in value.
  - **Never** let a material border coincide with an elevation terrace edge for this pair; **offset the seam from the cliff step**.
  - If routing an intermediate isn't possible, don't let black volcanic meet bright stone at all — route it to border a **darker** terrain instead.

## 5. Systemic notes (change the generator / tile library)

- **Value contrast, not hue, is the failure mode.** Every low-rated pair is a value cliff (white↔black, grey↔black); hue clashes (orange dirt↔grey stone, orange↔cyan) were all absorbed fine. **Rule for the generator: flag any adjacency whose base-tone value delta exceeds a threshold and auto-require an intermediate-value tile or terrain — a feather alone cannot hide it.**
- **Tile repetition is the #1 recurring defect** — bead-row puddles, stamped spike-rocks, polka-dot scree, repeated snow blobs, purplish transition band. **Add 2–3 variants per transition motif and jitter placement + density.** This one change lifts most of the 4s toward 5 and is higher-leverage than any per-pair fix.
- **Feather width: bump the default by +1 cell.** Multiple 4s noted the band goes too thin in stretches (grass↔dirt snaps; snow↔grass snowline wanders). Also jitter density along the isometric diagonal so fringes don't align into a "planted hedge / picket fence" row.
- **Orientation/sidedness is correct everywhere — keep it.** Every transition put the hard material intruding into the soft (scree/rubble/rock onto dirt/water/snow) and vegetation spilling onto bare earth. This logic is sound; **world layout must preserve it** by keeping stone/volcanic on the higher/harder side so the one-sided feather stays valid.
- **Decouple material seams from elevation steps.** Keep transitions on flat ground; where terrain must change at a terrace, offset the colour border from the cliff face. Coinciding them is what turned the stone↔volcanic pair into a chasm and made otherwise-fine scree look "grafted on."
- **Intermediate tiles should be tinted from their two neighbors, not a generic grey.** The black-volcanic↔snow band fell into a muddy purplish-grey belonging to neither terrain. For high-contrast pairs, add **library mid-tone bridge tiles** (e.g. a warm brown-grey rubble for dirt↔stone) sampled between the two palettes — the missing shared mid-tone is the only thing holding several borders at 4 instead of 5.
