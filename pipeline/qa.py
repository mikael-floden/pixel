"""QA gate. Every committed sprite frame must pass this before it lands.

Checks (all on the final pixelated RGBA frame):
  1. correct size
  2. non-empty (has opaque pixels)
  3. clean transparent border (1px frame all transparent)
  4. no stray/isolated opaque pixels (no tiny disconnected blobs)
  5. every opaque pixel within tolerance of the locked palette
"""

from __future__ import annotations

import json
import os

import numpy as np
from PIL import Image


class QAReport:
    def __init__(self):
        self.problems = []

    @property
    def ok(self):
        return not self.problems

    def fail(self, msg):
        self.problems.append(msg)

    def __repr__(self):
        return "QAReport(ok)" if self.ok else f"QAReport(FAIL: {self.problems})"


def _connected_components(mask):
    """Label 8-connected opaque blobs with an iterative flood fill.

    Returns a list of component sizes (pixel counts). numpy-only, deterministic.
    """
    h, w = mask.shape
    seen = np.zeros_like(mask, dtype=bool)
    sizes = []
    for sy in range(h):
        for sx in range(w):
            if not mask[sy, sx] or seen[sy, sx]:
                continue
            size = 0
            stack = [(sy, sx)]
            seen[sy, sx] = True
            while stack:
                y, x = stack.pop()
                size += 1
                for dy in (-1, 0, 1):
                    for dx in (-1, 0, 1):
                        if dy == 0 and dx == 0:
                            continue
                        ny, nx = y + dy, x + dx
                        if 0 <= ny < h and 0 <= nx < w and mask[ny, nx] and not seen[ny, nx]:
                            seen[ny, nx] = True
                            stack.append((ny, nx))
            sizes.append(size)
    return sizes


def run_qa(img, w, h, palette, alpha_threshold=128, tolerance=24, min_blob_px=3):
    """Validate one frame. `palette` is {hex: rgb} or a list of rgb tuples."""
    report = QAReport()

    if img.size != (w, h):
        report.fail(f"size {img.size} != ({w}, {h})")
        return report  # everything else assumes the right shape

    arr = np.array(img.convert("RGBA"))
    opaque = arr[:, :, 3] >= alpha_threshold

    if not opaque.any():
        report.fail("empty frame (no opaque pixels)")
        return report

    # Clean transparent border.
    if opaque[0, :].any() or opaque[-1, :].any() or opaque[:, 0].any() or opaque[:, -1].any():
        report.fail("opaque pixels touch the canvas border")

    # No stray/isolated blobs.
    sizes = _connected_components(opaque)
    strays = [s for s in sizes if s < min_blob_px]
    if strays:
        report.fail(f"{len(strays)} stray blob(s) smaller than {min_blob_px}px: {strays}")

    # Palette tolerance.
    if isinstance(palette, dict):
        palette_rgb = np.array(list(palette.values()), dtype=np.int32)
    else:
        palette_rgb = np.array(list(palette), dtype=np.int32)
    px = arr[opaque][:, :3].astype(np.int32)
    diff = px[:, None, :] - palette_rgb[None, :, :]
    dist = np.sqrt((diff * diff).sum(axis=2)).min(axis=1)
    worst = float(dist.max())
    if worst > tolerance:
        n_off = int((dist > tolerance).sum())
        report.fail(f"{n_off} opaque pixel(s) off-palette (max dist {worst:.1f} > {tolerance})")

    return report


def qa_file(path, w, h, palette, **kw):
    return run_qa(Image.open(path), w, h, palette, **kw)


def _load_palette_list():
    cfg = os.path.join(os.path.dirname(os.path.dirname(__file__)), "config", "palette.json")
    with open(cfg) as f:
        ramp = json.load(f)["ramp"]
    out = []
    for hx in ramp:
        hx = hx.lstrip("#")
        out.append((int(hx[0:2], 16), int(hx[2:4], 16), int(hx[4:6], 16)))
    return out


if __name__ == "__main__":
    import sys

    palette = _load_palette_list()
    if len(sys.argv) < 2:
        print("usage: python pipeline/qa.py <frame.png> [W H]")
        raise SystemExit(2)
    W = int(sys.argv[2]) if len(sys.argv) > 3 else 48
    H = int(sys.argv[3]) if len(sys.argv) > 3 else 64
    rep = qa_file(sys.argv[1], W, H, palette)
    print(rep)
    raise SystemExit(0 if rep.ok else 1)
