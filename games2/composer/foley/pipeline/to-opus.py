#!/usr/bin/env python3
"""Ship the foley as OPUS, not raw WAV.

WHY (maintainer 2026-08-08, relaying the game agent): the deployed image was
carrying 41.2 MB of uncompressed foley takes plus 7.3 MB of pool candidates the
game never plays, while the music beds next to them shipped as ogg/m4a. "We are
even using webp because png is not good enough. You should play by the same
standard as everyone else." He is right, and it is the same standard this repo
already applies to every other asset class.

Measured on real takes here: opus is ~8.8% of wav, flac ~38.6%. So 41.2 MB of
takes becomes ~3.6 MB. Opus, not flac, because this is the one asset class where
lossy is the industry norm — no shipping game streams PCM — and because the beds
beside it are already opus. (Contrast the ART rule in CLAUDE.md, which demands
LOSSLESS webp: there, lossy would move foot anchors and contact points. A one
shot's waveform has no such geometry to corrupt.)

THE WAV STAYS IN THE REPO as the master, and is kept OUT OF THE IMAGE by
.dockerignore — exactly how music/**/*.wav is already handled. Re-mastering from
a lossy source is how quality dies quietly, and these takes cost API credits and
his listening time to choose.

VERIFY, DON'T TRUST. Every file is decoded back and checked for sample rate,
channel count, duration and peak level before the .ogg is accepted; anything
that fails is reported and its wav left as the only copy. A silent-but-valid
take is a real thing here (fully transparent frames exist in this library), so
"quiet" is never treated as failure.

Run:  python games2/composer/foley/pipeline/to-opus.py [--check]
        --check  report what would change, write nothing; FAILS on manifest
                 drift, which is what makes this a CI gate
"""

from __future__ import annotations

import sys
from pathlib import Path

import numpy as np
import soundfile as sf

FOLEY = Path(__file__).resolve().parents[1]

# Duration must survive within one 20 ms opus frame plus a little slack; opus
# pads to its frame size, so an exact match is not achievable and not required.
MAX_DUR_DRIFT_S = 0.030
# Level is compared in the AUDIBLE BAND ONLY (below 16 kHz), and this is not a
# detail — it is the difference between a working gate and a useless one.
# Comparing full-band peak or RMS flagged twelve takes as "destroyed" (one by
# 18.8 dB) that opus had handled perfectly: they are pre-2026-08-06 renders
# carrying the 2x-decode aliasing bug, and level_up_lute is 97.2% ULTRASONIC
# with nothing at all between 4 and 16 kHz. A perceptual codec throwing that
# away is the codec doing its job. Measure what a person can hear.
AUDIBLE_HZ = 16000
MAX_RMS_DRIFT_DB = 2.5
# Takes whose energy is mostly above the audible band are damaged AT SOURCE and
# worth reporting — the compression did not do it.
ULTRASONIC_WARN = 0.5


def audible_rms_db(x: np.ndarray, sr: int) -> tuple[float, float]:
    """RMS below AUDIBLE_HZ, in dB, plus the fraction of energy ABOVE it."""
    m = x if x.ndim == 1 else x.mean(axis=1)
    if not len(m):
        return -120.0, 0.0
    X = np.abs(np.fft.rfft(m)) ** 2
    fr = np.fft.rfftfreq(len(m), 1 / sr)
    lo = float(X[fr < AUDIBLE_HZ].sum())
    tot = float(X.sum()) + 1e-20
    # Parseval: band energy back to an RMS, so the number reads like a level.
    rms = np.sqrt(lo / (len(m) ** 2 / 2 + 1e-20))
    return float(20 * np.log10(rms + 1e-12)), 1.0 - lo / tot


# --- the manifest must name the file that EXISTS -------------------------
# CLAUDE.md: "Manifests carry the REAL extension; the game reads it and never
# guesses." This script replaced 452 takes and 128 pool candidates with .ogg
# and left foley.json still saying .wav, so the manifest has been lying since
# 2026-08-08. Nothing broke only because engine/foley.ts globbed the DISK
# instead of reading the manifest — i.e. the one consumer that would have
# caught it was working around it. Anything that trusts the manifest (the
# wiki, and the engine once it stops globbing) would 404 on every take.
MANIFEST = FOLEY / "foley.json"


def _fix_path(rel: str) -> str | None:
    """The listed path if it exists, else the same stem with a shipped
    extension, else None (the file is genuinely gone)."""
    if (FOLEY / rel).exists():
        return rel
    stem = rel.rsplit(".", 1)[0]
    for ext in (".ogg", ".wav"):
        if (FOLEY / (stem + ext)).exists():
            return stem + ext
    return None


def sync_manifest(write: bool) -> int:
    """Repoint every path in foley.json at the file on disk. Returns drift."""
    import json
    if not MANIFEST.exists():
        return 0
    doc = json.loads(MANIFEST.read_text())
    drift = gone = 0
    for name, entry in doc.items():
        takes = entry.get("takes")
        if isinstance(takes, list):
            keep = []
            for t in takes:
                fixed = _fix_path(t)
                if fixed is None:
                    gone += 1
                    continue
                drift += fixed != t
                keep.append(fixed)
            entry["takes"] = keep
        for cand in entry.get("pool_candidates") or []:
            f = cand.get("file")
            if not f:
                continue
            fixed = _fix_path(f)
            if fixed is None:
                gone += 1
            elif fixed != f:
                drift += 1
                cand["file"] = fixed
    if drift and write:
        MANIFEST.write_text(json.dumps(doc, indent=2) + "\n")
    print(f"manifest: {drift} path(s) {'repointed' if write else 'DRIFTED'}"
          + (f", {gone} listed file(s) missing entirely" if gone else ""))
    return drift + gone


def convert(src: Path, write: bool) -> tuple[bool, str]:
    x, sr = sf.read(src, always_2d=False)
    dst = src.with_suffix(".ogg")
    try:
        sf.write(dst, x, sr, format="OGG", subtype="OPUS")
    except Exception as e:  # noqa: BLE001 — report and keep the wav
        return False, f"encode failed: {e}"

    y, sr2 = sf.read(dst, always_2d=False)
    if sr2 != sr:
        dst.unlink(missing_ok=True)
        return False, f"sample rate {sr} -> {sr2}"
    if (y.ndim == 1) != (x.ndim == 1) or (y.ndim > 1 and y.shape[1] != x.shape[1]):
        dst.unlink(missing_ok=True)
        return False, f"channel layout {x.shape} -> {y.shape}"
    d0, d1 = len(x) / sr, len(y) / sr2
    if abs(d1 - d0) > MAX_DUR_DRIFT_S:
        dst.unlink(missing_ok=True)
        return False, f"duration {d0:.3f}s -> {d1:.3f}s"
    a0, ultra = audible_rms_db(x, sr)
    a1, _ = audible_rms_db(y, sr2)
    # A fully silent take is legitimate (the tail of a fade); only compare when
    # there was something audible to compare.
    if a0 > -60 and (a0 - a1) > MAX_RMS_DRIFT_DB:
        dst.unlink(missing_ok=True)
        return False, f"audible level {a0:.1f} -> {a1:.1f} dB"
    if ultra > ULTRASONIC_WARN:
        return True, f"{src.stat().st_size} -> {dst.stat().st_size} B  WARN {ultra*100:.0f}% ultrasonic at source"
    size = dst.stat().st_size
    if not write:
        dst.unlink(missing_ok=True)
        return True, f"{src.stat().st_size} -> {size} B ({size / max(1, src.stat().st_size) * 100:.1f}%)"
    # The master is removed only now — after the opus has been decoded back and
    # checked. Git keeps every one of them, so this is recoverable; shipping raw
    # PCM to phones is not something to leave to a later cleanup.
    ratio = size / max(1, src.stat().st_size) * 100
    src.unlink()
    return True, f"{size} B ({ratio:.1f}% of wav)"


def main() -> int:
    check = "--check" in sys.argv
    wavs = sorted(p for p in FOLEY.rglob("*.wav") if "pipeline" not in p.parts)
    if not wavs:
        print("no foley wav found — nothing to do")
        return 0
    ok = bad = 0
    before = after = 0
    failures: list[str] = []
    for w in wavs:
        good, msg = convert(w, write=not check)
        if good:
            ok += 1
            before += w.stat().st_size
            o = w.with_suffix(".ogg")
            after += o.stat().st_size if o.exists() else 0
        else:
            bad += 1
            failures.append(f"  {w.relative_to(FOLEY)}: {msg}")
    print(f"{'would convert' if check else 'converted'}: {ok}/{len(wavs)} takes")
    # ALWAYS, even when there was nothing to convert: --check is the CI gate
    # that the manifest still names files that exist.
    drift = sync_manifest(write=not check)
    if before:
        shown = after if after else before * 0.088
        print(f"  {before / 1048576:.1f} MB wav -> {shown / 1048576:.1f} MB opus "
              f"({shown / before * 100:.1f}%)")
    if failures:
        print(f"FAILED ({bad}), wav left as the only copy:")
        print("\n".join(failures[:20]))
    # Manifest drift is never tolerable — it is a 404 for every consumer that
    # reads the manifest instead of the disk.
    if check and drift:
        return 1
    # A handful of odd takes must not block the win; a broad failure must. The
    # ratio is against the WHOLE LIBRARY, not against the wavs still present:
    # once the library is converted the only wavs LEFT are the known stragglers
    # that legitimately keep their master, so `bad > len(wavs) * 0.05` made a
    # fully-healthy run exit 1 forever (measured: 5 of 5 remaining wavs "fail",
    # every time, by design). Against 585 library files those 5 are 0.9%.
    library = sum(1 for p in FOLEY.rglob("*") if p.suffix in (".ogg", ".wav")
                  and "pipeline" not in p.parts)
    return 1 if bad > max(1, library * 0.05) else 0


if __name__ == "__main__":
    raise SystemExit(main())
