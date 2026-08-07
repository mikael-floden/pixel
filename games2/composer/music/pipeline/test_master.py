"""Validate the composer's music DSP against known references."""
import os
import sys

import numpy as np

# Next to the modules under test, wherever the repo is checked out (this used
# to be an absolute path that only worked by luck: a script's own directory is
# already on sys.path, so the dead entry was simply ignored).
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import master as M

SR = 44100
fails = []


def check(name, got, lo, hi):
    ok = (got == lo) if (lo == hi and isinstance(lo, str)) else (lo <= got <= hi)
    print(f"{'PASS' if ok else 'FAIL'}  {name:38} {got!r}  expected [{lo}, {hi}]")
    if not ok:
        fails.append(name)


# --- BS.1770 calibration: 0 dBFS 997 Hz sine in ONE channel == -3.01 LKFS ----
t = np.arange(SR * 5) / SR
sine = np.sin(2 * np.pi * 997 * t).astype(np.float32)
one_ch = np.stack([sine, np.zeros_like(sine)], axis=1)
check("BS.1770 single-channel 0 dBFS tone", round(M.loudness_lufs(one_ch, SR), 2), -3.11, -2.91)

# Same tone in BOTH channels: power sums -> +3.01 LU louder.
both = np.stack([sine, sine], axis=1)
check("BS.1770 dual-channel 0 dBFS tone", round(M.loudness_lufs(both, SR), 2), -0.10, 0.10)

# -20 dBFS version must track exactly 20 dB down.
check("linearity (-20 dB tone)", round(M.loudness_lufs(one_ch * 0.1, SR), 2), -23.11, -22.91)

# --- true peak: an inter-sample peak must read ABOVE the sample peak --------
# 11.025 kHz at Nyquist/4 sampled so samples straddle the crest.
tp_sig = np.sin(2 * np.pi * 11025 * t + np.pi / 4).astype(np.float32)[:, None]
sample_peak = 20 * np.log10(np.max(np.abs(tp_sig)))
tp = M.true_peak_dbfs(tp_sig, SR)
print(f"      sample peak {sample_peak:.2f} dBFS -> true peak {tp:.2f} dBTP")
check("true peak >= sample peak", tp > sample_peak - 0.01, True, True)

# --- master(): loudness lands on target, true peak under ceiling ------------
rng = np.random.default_rng(7)
# noise bed + a tone, stereo, deliberately far too loud
bt = np.arange(SR * 12) / SR
noise = rng.standard_normal((SR * 12, 2)).astype(np.float32) * 0.35
bed = noise + 0.4 * np.stack([np.sin(2 * np.pi * 220 * bt),
                              np.sin(2 * np.pi * 220 * bt + 0.5)], axis=1)
out, info = M.master(bed.astype(np.float32), SR)
print("      master info:", info)
check("mastered LUFS on target", info["lufs_out"], M.TARGET_LUFS - 0.6, M.TARGET_LUFS + 0.6)
check("mastered true peak under ceiling", info["true_peak_dbtp"] <= M.CEILING_DBTP + 0.05, True, True)

# A quiet input must be brought UP to the same target (that is the whole point).
quiet_out, quiet_info = M.master((bed * 0.02).astype(np.float32), SR)
check("quiet input matched to same target", quiet_info["lufs_out"],
      M.TARGET_LUFS - 0.6, M.TARGET_LUFS + 0.6)

# --- lead-in trim: 3 s of silence in front must be detected -----------------
lead = np.concatenate([np.zeros((SR * 3, 2), dtype=np.float32), bed.astype(np.float32)])
check("lead_in_s detects 3 s of silence", round(M.lead_in_s(M.to_mono(lead), SR), 1), 2.8, 3.2)
_, lead_info = M.master(lead, SR)
check("master trims the silent head", lead_info.get("trimmed_lead_s", 0), 2.8, 3.2)

# --- loop finder: a track built from a 20 s repeating pattern ---------------
# Distinct pattern so the matching passage is unambiguous, then 3 repeats.
pat_len = 20.0
pt = np.arange(int(SR * pat_len)) / SR
# A monotonic sweep over the whole period: the spectrum at any instant is
# UNIQUE within the pattern, so only a whole-period offset can match (the
# earlier take had an internal 2 s gate, which legitimately matched at 44 s).
f_inst = 110.0 * (3.0 ** (pt / pat_len))
pattern = (0.35 * np.sin(2 * np.pi * np.cumsum(f_inst) / SR)).astype(np.float32)
loopy = np.tile(pattern, 4)
res = M.find_loop(loopy, SR, bpm=None, min_loop_s=15.0)
period = res["loop_end_s"] - res["loop_start_s"]
print("      loop result:", res, f"-> period {period:.2f}s")
check("loop period is a multiple of 20 s", round(abs(period / pat_len - round(period / pat_len)), 2), 0.0, 0.06)
check("loop seam score is high", res["score"], 0.80, 1.01)

# --- measure() returns a full card without crashing ------------------------
card = M.measure(bed.astype(np.float32), SR)
print("      measure card:", card)
check("measure: duration", card["duration_s"], 11.9, 12.1)
check("measure: stereo_corr sane", abs(card["stereo_corr"]) <= 1.0, True, True)

# --- container sniffing: our OWN delivery formats must be recognised -------
# An unrecognised container fell through to the raw-PCM branch, which does not
# fail — it reads a 1.7 MB opus file as ~10 s of clipping noise.
check("sniff wav", M.sniff_container(b"RIFF....WAVEfmt "), "wav", "wav")
check("sniff ogg", M.sniff_container(b"OggS\x00\x02\x00\x00"), "ogg", "ogg")
check("sniff m4a", M.sniff_container(b"\x00\x00\x00\x20ftypM4A "), "m4a", "m4a")
check("sniff mp3 (ID3)", M.sniff_container(b"ID3\x04\x00\x00\x00"), "mp3", "mp3")
check("sniff mp3 (sync)", M.sniff_container(b"\xff\xfb\x90\x00"), "mp3", "mp3")
check("sniff raw pcm", M.sniff_container(b"\x01\x00\x02\x00\x03\x00"), "pcm", "pcm")

# --- candidate scoring: a degenerate take must never win --------------------
# THE REAL REGRESSION: the first battle run shipped a 0.07 s file. The additive
# score gave it 42 points for what it trivially "passed" (no lead-in and no
# silence are free when there is no audio) while a flat fade-out penalty halved
# both genuine 90 s takes below it.
import generate as G

BROKEN = dict(duration_s=0.07, lufs=-70.0, true_peak_dbtp=6.15, lead_in_s=0.0,
              tail_rms_ratio=1.0, crest_db=4.13, centroid_hz=7812.4,
              stereo_corr=0.424, silence_frac=0.0)
REAL = dict(duration_s=89.95, lufs=-10.41, true_peak_dbtp=-0.2, lead_in_s=0.0,
            tail_rms_ratio=0.0, crest_db=13.57, centroid_hz=6741.4,
            stereo_corr=0.27, silence_frac=0.038)
broken_score = G.score_candidate(BROKEN, {"score": 0.0}, 90, True)[0]
real_score = G.score_candidate(REAL, {"score": 0.9541}, 90, True)[0]
print(f"      broken 0.07s take scores {broken_score}, real 90s take scores {real_score}")
check("truncated take is disqualified", broken_score, 0.0, 0.0)
check("real take beats the broken one", real_score > broken_score, True, True)
check("silent take is disqualified",
      G.score_candidate({**REAL, "lufs": -70.0}, {"score": 0.95}, 90, True)[0], 0.0, 0.0)
check("mostly-silent take is disqualified",
      G.score_candidate({**REAL, "silence_frac": 0.8}, {"score": 0.95}, 90, True)[0], 0.0, 0.0)
# A fade-out only counts against a take we would actually play to the end.
faded_loopable = G.score_candidate(REAL, {"score": 0.95}, 90, True)[0]
faded_unloopable = G.score_candidate(REAL, {"score": 0.5}, 90, True)[0]
check("fade-out is forgiven when the loop avoids it", faded_loopable > faded_unloopable, True, True)

print()
print("FAILURES:", fails if fails else "none")
sys.exit(1 if fails else 0)
