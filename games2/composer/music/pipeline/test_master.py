"""Validate the composer's music DSP against known references."""
import sys
import numpy as np

sys.path.insert(0, "/home/user/pixel/games2/composer/music/pipeline")
import master as M

SR = 44100
fails = []


def check(name, got, lo, hi):
    ok = lo <= got <= hi
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

print()
print("FAILURES:", fails if fails else "none")
sys.exit(1 if fails else 0)
