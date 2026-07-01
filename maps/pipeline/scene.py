"""Build one scene-based loading zone.

PixelLab draws the painted ground scene (art-directed with a palette reference);
we upscale it to the world canvas, derive a walkable-grid collision mask from the
art, place the objects agent's props on a y-sorted entity layer (with drop
shadows), add exits, render a preview, and write a self-contained `zone.json`
(schema pixel-maps/zone@2-scene). No tiles, no prop generation. See maps/README.md.
"""

from __future__ import annotations

import json
import os
import random

from PIL import Image, ImageDraw, ImageFilter

import props as props_mod
import proportions

ROOT = os.path.dirname(os.path.dirname(__file__))
SCHEMA = "pixel-maps/zone@2-scene"


def zone_dir(zid):
    return os.path.join(ROOT, zid)


def zone_exists(zid):
    return os.path.isfile(os.path.join(zone_dir(zid), "zone.json"))


def list_zones():
    out = []
    for name in sorted(os.listdir(ROOT)):
        p = os.path.join(ROOT, name, "zone.json")
        if os.path.isfile(p):
            with open(p) as f:
                out.append(json.load(f))
    return out


def _shadow(w, h):
    s = Image.new("RGBA", (max(2, w), max(2, h)), (0, 0, 0, 0))
    ImageDraw.Draw(s).ellipse([0, 0, s.width - 1, s.height - 1], fill=(0, 0, 0, 110))
    return s.filter(ImageFilter.GaussianBlur(3))


def _derive_collision(scene, cell_native, world_scale):
    """Walkable-grid from the painted ground: bright olive clearing = walkable,
    dark foliage / deep water = blocked. cell in WORLD px = cell_native*world_scale."""
    gw = scene.width // cell_native
    gh = scene.height // cell_native
    rgb = scene.convert("RGB")
    grid = [[1] * gw for _ in range(gh)]
    for r in range(gh):
        for c in range(gw):
            crop = rgb.crop((c * cell_native, r * cell_native,
                             (c + 1) * cell_native, (r + 1) * cell_native))
            px = list(crop.getdata())
            n = len(px)
            rr = sum(p[0] for p in px) / n
            gg = sum(p[1] for p in px) / n
            bb = sum(p[2] for p in px) / n
            lum = 0.3 * rr + 0.6 * gg + 0.1 * bb
            is_water = bb > rr + 10 and bb > gg - 10        # blue-dominant = water
            is_dark = lum < 95                               # dark foliage / shadow
            # Walkable = bright ground that isn't water: grass clearings AND sandy
            # beaches / dirt (warm, not blue-dominant) both count.
            walkable = (not is_water) and (not is_dark) and gg > 60
            grid[r][c] = 0 if walkable else 1
    return grid, gw, gh


def _walkable_cells(grid):
    return [(c, r) for r, row in enumerate(grid) for c, v in enumerate(row) if v == 0]


def build_zone(client, cfg, zone_def, push_log=print):
    """Generate + assemble one scene zone. One PixelLab op (the scene). Returns
    the manifest dict."""
    zid = zone_def["id"]
    d = cfg.get("defaults", {})
    view = zone_def.get("view", d.get("view", "high top-down"))
    w, h = zone_def.get("scene_size", [320, 224])
    scale = int(zone_def.get("scene_scale", d.get("scene_scale", 3)))
    palette = None
    pref = cfg.get("palette_reference")
    if pref and os.path.isfile(os.path.join(ROOT, pref)):
        palette = Image.open(os.path.join(ROOT, pref)).convert("RGBA")

    desc = f"{zone_def['prompt']}, {cfg.get('style_base','')}"
    scene = client.create_scene(
        description=desc, width=w, height=h, view=view,
        outline=d.get("outline"), shading=d.get("shading"), detail=d.get("detail"),
        seed=zone_def.get("seed"), color_image=palette)

    world = scene.resize((scene.width * scale, scene.height * scale), Image.LANCZOS)
    W, H = world.size

    cell_native = int(zone_def.get("collision_cell_native", 16))
    grid, gw, gh = _derive_collision(scene, cell_native, scale)
    cell_world = cell_native * scale

    # --- place props on walkable cells near the foliage border (curated) ---
    rng = random.Random(zone_def.get("seed", 0) ^ 0xA11)
    char_h = proportions.character_px(H)
    scales = cfg.get("prop_scale", {})
    pool = [p for p in zone_def.get("props", []) if p in set(props_mod.available())]
    walk = _walkable_cells(grid)
    # prefer cells adjacent to a blocked cell (edge of the clearing) for a natural look
    def near_edge(c, r):
        return any(0 <= r + dr < gh and 0 <= c + dc < gw and grid[r + dr][c + dc] == 1
                   for dc, dr in ((1, 0), (-1, 0), (0, 1), (0, -1)))
    edge_cells = [cell for cell in walk if near_edge(*cell)]
    rng.shuffle(edge_cells)
    taken = set()
    entities = []
    sprites = {}
    want = int(zone_def.get("prop_count", 6))
    for (c, r) in edge_cells:
        if len(entities) >= want or not pool:
            break
        if (c, r) in taken:
            continue
        taken.update({(c + dc, r + dr) for dc in (-1, 0, 1) for dr in (-1, 0, 1)})
        pid = rng.choice(pool)
        s = scales.get(pid, proportions.DEFAULT_PROP_SCALE)
        hpx = proportions.prop_height(s, H)
        if pid not in sprites:
            sprites[pid] = props_mod.sprite(pid, hpx)
        else:
            sprites[pid] = props_mod.sprite(pid, hpx)
        bx = c * cell_world + cell_world // 2
        by = (r + 1) * cell_world
        entities.append({"id": pid, "file": f"objects/{pid}.png",
                         "x": bx, "base_y": by, "layer": "entity"})

    # spawn at the most central walkable cell
    if walk:
        cx, cy = gw / 2, gh / 2
        sc, sr = min(walk, key=lambda cr: (cr[0] - cx) ** 2 + (cr[1] - cy) ** 2)
        spawn = {"x": sc * cell_world + cell_world // 2, "y": (sr + 1) * cell_world}
    else:
        spawn = {"x": W // 2, "y": H // 2}

    # --- write zone folder ---
    zd = zone_dir(zid)
    odir = os.path.join(zd, "objects")
    os.makedirs(odir, exist_ok=True)
    for pid, im in sprites.items():
        im.save(os.path.join(odir, f"{pid}.png"))
    world.convert("RGB").save(os.path.join(zd, "scene.png"))

    # preview: world + y-sorted entities (+ shadows), spawn marker optional
    prev = world.copy()
    draw = [(e["x"], e["base_y"], sprites[e["id"]]) for e in entities]
    for bx, by, im in sorted(draw, key=lambda e: e[1]):
        sw, sh = int(im.width * 0.6), max(6, int(im.height * 0.10))
        prev.alpha_composite(_shadow(sw, sh), (int(bx - sw / 2), int(by - sh / 2)))
        prev.alpha_composite(im, (int(bx - im.width / 2), int(by - im.height)))
    prev.convert("RGB").save(os.path.join(zd, "preview.png"))

    vis = world.convert("RGB").copy()
    dr = ImageDraw.Draw(vis, "RGBA")
    for r in range(gh):
        for c in range(gw):
            if grid[r][c]:
                dr.rectangle([c * cell_world, r * cell_world,
                              (c + 1) * cell_world, (r + 1) * cell_world], fill=(255, 0, 0, 70))
    vis.save(os.path.join(zd, "collision.png"))

    exits = []
    for ex in zone_def.get("exits", []):
        edge = ex.get("edge", "north")
        pos = {"north": (W // 2, 0), "south": (W // 2, H), "east": (W, H // 2),
               "west": (0, H // 2)}.get(edge, (W // 2, 0))
        exits.append({"id": ex.get("id", edge), "kind": ex.get("kind", "path"),
                      "edge": edge, "x": pos[0], "y": pos[1],
                      "to_zone": ex.get("to_zone"), "to_exit": ex.get("to_exit")})

    manifest = {
        "schema": SCHEMA, "id": zid, "title": zone_def.get("title", zid),
        "kind": zone_def.get("kind", "island_screen"), "mood": zone_def.get("mood", ""),
        "view": view, "background": "scene.png",
        "pixel_size": {"width": W, "height": H},
        "camera": {"viewport": {"width": min(W, 480), "height": min(H, 336)},
                   "note": "world is larger than the viewport; scroll to follow the player"},
        "layers": ["background", "entities", "overhead"],
        "collision": {"encoding": "walkable-grid", "cell": cell_world,
                      "width": gw, "height": gh, "legend": {"0": "walkable", "1": "blocked"},
                      "derived_from": "scene.png", "data": grid},
        "spawn": spawn, "entities": entities, "overhead": [],
        "exits": exits, "preview": "preview.png", "collision_preview": "collision.png",
        "provenance": {"background": "pixellab create-image-pixflux (palette-guided)",
                       "props": "objects agent (/objects)"},
    }
    with open(os.path.join(zd, "zone.json"), "w") as f:
        json.dump(manifest, f, indent=2)
    push_log(f"scene zone '{zid}' ({W}x{H}, {len(entities)} props, "
             f"{sum(row.count(0) for row in grid)}/{gw*gh} walkable)")
    return manifest
