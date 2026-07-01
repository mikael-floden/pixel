"""A pure-Python port of DrPetter's **sfxr** procedural sound-effect synth.

sfxr (and its descendants bfxr / as3sfxr / jsfxr) is the de-facto standard for
generating retro / 8-bit game sound effects: coin pickups, jumps, lasers, hits,
explosions, UI blips. It needs no model, no network and no API key — a compact
oscillator + envelope + filter chain driven by ~24 parameters. That makes it the
right *default* engine for this repo's loop: deterministic (seeded), free, and
runnable in CI today.

This module is a faithful port of the reference synthesis loop (public domain,
DrPetter 2007) plus the classic preset generators from as3sfxr. Output is a
mono float array in [-1, 1]; `render_wav` peak-normalises and writes a 16-bit
PCM WAV using only the standard library + numpy (already a repo dependency).

Nothing here is game-specific; `factory.py` maps game events onto these presets.
"""

from __future__ import annotations

import math
import random
import wave
from dataclasses import dataclass, asdict, fields

import numpy as np

SAMPLE_RATE = 44100

# Wave shapes (sfxr numbering).
SQUARE, SAWTOOTH, SINE, NOISE = 0, 1, 2, 3
WAVE_NAMES = {SQUARE: "square", SAWTOOTH: "sawtooth", SINE: "sine", NOISE: "noise"}


@dataclass
class Params:
    """The sfxr parameter vector. Ranges/semantics match the original tool, so a
    manifest carrying these values can be pasted straight into jsfxr/bfxr."""

    wave_type: int = SQUARE

    # Envelope (attack -> sustain -> decay), each 0..1 (mapped to time^2).
    p_env_attack: float = 0.0
    p_env_sustain: float = 0.3
    p_env_punch: float = 0.0
    p_env_decay: float = 0.4

    # Frequency.
    p_base_freq: float = 0.3
    p_freq_limit: float = 0.0
    p_freq_ramp: float = 0.0
    p_freq_dramp: float = 0.0

    # Vibrato.
    p_vib_strength: float = 0.0
    p_vib_speed: float = 0.0

    # Arpeggio (a single pitch jump partway through).
    p_arp_mod: float = 0.0
    p_arp_speed: float = 0.0

    # Square duty cycle (only affects the square wave).
    p_duty: float = 0.0
    p_duty_ramp: float = 0.0

    # Retrigger.
    p_repeat_speed: float = 0.0

    # Flanger / phaser.
    p_pha_offset: float = 0.0
    p_pha_ramp: float = 0.0

    # Filters.
    p_lpf_freq: float = 1.0
    p_lpf_ramp: float = 0.0
    p_lpf_resonance: float = 0.0
    p_hpf_freq: float = 0.0
    p_hpf_ramp: float = 0.0

    sound_vol: float = 0.5

    def to_jsfxr_dict(self) -> dict:
        """Manifest-friendly dict (plain floats/ints, wave name included)."""
        d = asdict(self)
        d["wave_type_name"] = WAVE_NAMES.get(self.wave_type, str(self.wave_type))
        return d

    @classmethod
    def from_dict(cls, d: dict) -> "Params":
        known = {f.name for f in fields(cls)}
        return cls(**{k: v for k, v in d.items() if k in known})


# --- preset generators (ported from as3sfxr Generator) ----------------------
#
# Each takes a seeded RNG so a given (preset, seed) is fully reproducible.

def _mk(rng):
    frnd = lambda x: rng.random() * x           # noqa: E731  float in [0,x)
    rnd = lambda n: rng.randint(0, n)           # noqa: E731  int in [0,n]
    return frnd, rnd


def pickup_coin(rng) -> Params:
    frnd, rnd = _mk(rng)
    p = Params()
    p.p_base_freq = 0.4 + frnd(0.5)
    p.p_env_attack = 0.0
    p.p_env_sustain = frnd(0.1)
    p.p_env_decay = 0.1 + frnd(0.4)
    p.p_env_punch = 0.3 + frnd(0.3)
    if rnd(1):
        p.p_arp_speed = 0.5 + frnd(0.2)
        p.p_arp_mod = 0.2 + frnd(0.4)
    return p


def laser_shoot(rng) -> Params:
    frnd, rnd = _mk(rng)
    p = Params()
    p.wave_type = rnd(2)
    if p.wave_type == SINE and rnd(1):
        p.wave_type = rnd(1)
    p.p_base_freq = 0.5 + frnd(0.5)
    p.p_freq_limit = p.p_base_freq - 0.2 - frnd(0.6)
    if p.p_freq_limit < 0.2:
        p.p_freq_limit = 0.2
    p.p_freq_ramp = -0.15 - frnd(0.2)
    if rnd(2) == 0:
        p.p_base_freq = 0.3 + frnd(0.6)
        p.p_freq_limit = frnd(0.1)
        p.p_freq_ramp = -0.35 - frnd(0.3)
    if rnd(1):
        p.p_duty = frnd(0.5)
        p.p_duty_ramp = frnd(0.2)
    else:
        p.p_duty = 0.4 + frnd(0.5)
        p.p_duty_ramp = -frnd(0.7)
    p.p_env_attack = 0.0
    p.p_env_sustain = 0.1 + frnd(0.2)
    p.p_env_decay = frnd(0.4)
    if rnd(1):
        p.p_env_punch = frnd(0.3)
    if rnd(2) == 0:
        p.p_pha_offset = frnd(0.2)
        p.p_pha_ramp = -frnd(0.2)
    if rnd(1):
        p.p_hpf_freq = frnd(0.3)
    return p


def explosion(rng) -> Params:
    frnd, rnd = _mk(rng)
    p = Params()
    p.wave_type = NOISE
    if rnd(1):
        p.p_base_freq = 0.1 + frnd(0.4)
        p.p_freq_ramp = -0.1 + frnd(0.4)
    else:
        p.p_base_freq = 0.2 + frnd(0.7)
        p.p_freq_ramp = -0.2 - frnd(0.2)
    p.p_base_freq *= p.p_base_freq
    if rnd(4) == 0:
        p.p_freq_ramp = 0.0
    if rnd(2) == 0:
        p.p_repeat_speed = 0.3 + frnd(0.5)
    p.p_env_attack = 0.0
    p.p_env_sustain = 0.1 + frnd(0.3)
    p.p_env_decay = frnd(0.5)
    if rnd(1) == 0:
        p.p_pha_offset = -0.3 + frnd(0.9)
        p.p_pha_ramp = -frnd(0.3)
    p.p_env_punch = 0.2 + frnd(0.6)
    if rnd(1):
        p.p_vib_strength = frnd(0.7)
        p.p_vib_speed = frnd(0.6)
    if rnd(2) == 0:
        p.p_arp_speed = 0.6 + frnd(0.3)
        p.p_arp_mod = 0.8 - frnd(1.6)
    return p


def power_up(rng) -> Params:
    frnd, rnd = _mk(rng)
    p = Params()
    if rnd(1):
        p.wave_type = SAWTOOTH
    else:
        p.p_duty = frnd(0.6)
    if rnd(1):
        p.p_base_freq = 0.2 + frnd(0.3)
        p.p_freq_ramp = 0.1 + frnd(0.4)
        p.p_repeat_speed = 0.4 + frnd(0.4)
    else:
        p.p_base_freq = 0.2 + frnd(0.3)
        p.p_freq_ramp = 0.05 + frnd(0.2)
        if rnd(1):
            p.p_vib_strength = frnd(0.7)
            p.p_vib_speed = frnd(0.6)
    p.p_env_attack = 0.0
    p.p_env_sustain = frnd(0.4)
    p.p_env_decay = 0.1 + frnd(0.4)
    return p


def hit_hurt(rng) -> Params:
    frnd, rnd = _mk(rng)
    p = Params()
    p.wave_type = rnd(2)
    if p.wave_type == SINE:
        p.wave_type = NOISE
    if p.wave_type == SQUARE:
        p.p_duty = frnd(0.6)
    p.p_base_freq = 0.2 + frnd(0.6)
    p.p_freq_ramp = -0.3 - frnd(0.4)
    p.p_env_attack = 0.0
    p.p_env_sustain = frnd(0.1)
    p.p_env_decay = 0.1 + frnd(0.2)
    if rnd(1):
        p.p_hpf_freq = frnd(0.3)
    return p


def jump(rng) -> Params:
    frnd, rnd = _mk(rng)
    p = Params()
    p.wave_type = SQUARE
    p.p_duty = frnd(0.6)
    p.p_base_freq = 0.3 + frnd(0.3)
    p.p_freq_ramp = 0.1 + frnd(0.2)
    p.p_env_attack = 0.0
    p.p_env_sustain = 0.1 + frnd(0.3)
    p.p_env_decay = 0.1 + frnd(0.2)
    if rnd(1):
        p.p_hpf_freq = frnd(0.3)
    if rnd(1):
        p.p_lpf_freq = 1.0 - frnd(0.6)
    return p


def blip_select(rng) -> Params:
    frnd, rnd = _mk(rng)
    p = Params()
    p.wave_type = rnd(1)
    if p.wave_type == SQUARE:
        p.p_duty = frnd(0.6)
    p.p_base_freq = 0.2 + frnd(0.4)
    p.p_env_attack = 0.0
    p.p_env_sustain = 0.1 + frnd(0.1)
    p.p_env_decay = frnd(0.2)
    p.p_hpf_freq = 0.1
    return p


def tone(rng) -> Params:
    """A clean, steady beep — useful base for notifications / neutral UI."""
    frnd, _ = _mk(rng)
    p = Params()
    p.wave_type = SINE
    p.p_base_freq = 0.3 + frnd(0.3)
    p.p_env_attack = 0.0
    p.p_env_sustain = 0.2 + frnd(0.2)
    p.p_env_decay = 0.1 + frnd(0.2)
    return p


PRESETS = {
    "pickupCoin": pickup_coin,
    "laserShoot": laser_shoot,
    "explosion": explosion,
    "powerUp": power_up,
    "hitHurt": hit_hurt,
    "jump": jump,
    "blipSelect": blip_select,
    "tone": tone,
}


# --- the synthesis core -----------------------------------------------------

def synthesize(p: Params, sample_rate: int = SAMPLE_RATE) -> np.ndarray:
    """Render `p` to a mono float32 array in [-1, 1] (pre-normalisation).

    A direct port of sfxr's `SynthSample`: an oscillator (square / saw / sine /
    noise) shaped by a 3-stage volume envelope, frequency slide + vibrato +
    arpeggio, an optional low-pass/high-pass filter and a phaser, at 8x
    supersampling. Runs until the envelope finishes (or the frequency slide hits
    its limit)."""
    rng = random.Random(0x5f3759df)  # fixed: only used for the noise table

    fperiod = 100.0 / (p.p_base_freq * p.p_base_freq + 0.001)
    fmaxperiod = 100.0 / (p.p_freq_limit * p.p_freq_limit + 0.001)
    fslide = 1.0 - math.pow(p.p_freq_ramp, 3.0) * 0.01
    fdslide = -math.pow(p.p_freq_dramp, 3.0) * 0.000001

    square_duty = 0.5 - p.p_duty * 0.5
    square_slide = -p.p_duty_ramp * 0.00005

    if p.p_arp_mod >= 0.0:
        arp_mod = 1.0 - math.pow(p.p_arp_mod, 2.0) * 0.9
    else:
        arp_mod = 1.0 + math.pow(p.p_arp_mod, 2.0) * 10.0
    arp_time = 0
    arp_limit = int(math.pow(1.0 - p.p_arp_speed, 2.0) * 20000 + 32)
    if p.p_arp_speed == 1.0:
        arp_limit = 0

    # Filters.
    fltp = fltdp = fltphp = 0.0
    fltw = math.pow(p.p_lpf_freq, 3.0) * 0.1
    fltw_d = 1.0 + p.p_lpf_ramp * 0.0001
    fltdmp = 5.0 / (1.0 + math.pow(p.p_lpf_resonance, 2.0) * 20.0) * (0.01 + fltw)
    fltdmp = min(fltdmp, 0.8)
    flthp = math.pow(p.p_hpf_freq, 2.0) * 0.1
    flthp_d = 1.0 + p.p_hpf_ramp * 0.0003

    # Vibrato.
    vib_phase = 0.0
    vib_speed = math.pow(p.p_vib_speed, 2.0) * 0.01
    vib_amp = p.p_vib_strength * 0.5

    # Envelope.
    env_vol = 0.0
    env_stage = 0
    env_time = 0
    env_length = [
        max(1, int(p.p_env_attack * p.p_env_attack * 100000.0)),
        max(1, int(p.p_env_sustain * p.p_env_sustain * 100000.0)),
        max(1, int(p.p_env_decay * p.p_env_decay * 100000.0)),
    ]

    # Phaser.
    fphase = math.pow(p.p_pha_offset, 2.0) * 1020.0
    if p.p_pha_offset < 0.0:
        fphase = -fphase
    fdphase = math.pow(p.p_pha_ramp, 2.0) * 1.0
    if p.p_pha_ramp < 0.0:
        fdphase = -fdphase
    iphase = min(1023, abs(int(fphase)))
    phaser_buffer = [0.0] * 1024
    ipp = 0

    noise_buffer = [rng.random() * 2.0 - 1.0 for _ in range(32)]

    rep_time = 0
    rep_limit = int(math.pow(1.0 - p.p_repeat_speed, 2.0) * 20000 + 32)
    if p.p_repeat_speed == 0.0:
        rep_limit = 0

    period = int(fperiod)
    phase = 0
    playing = True
    out = []
    two_pi = 2.0 * math.pi
    # Hard cap so a pathological parameter set can't spin forever (~10 s).
    max_samples = sample_rate * 10

    while playing and len(out) < max_samples:
        rep_time += 1
        if rep_limit != 0 and rep_time >= rep_limit:
            rep_time = 0
            # Retrigger: reset only the pitch state (sfxr's restart path).
            fperiod = 100.0 / (p.p_base_freq * p.p_base_freq + 0.001)
            period = int(fperiod)
            square_duty = 0.5 - p.p_duty * 0.5
            arp_time = 0
            arp_limit = int(math.pow(1.0 - p.p_arp_speed, 2.0) * 20000 + 32)
            if p.p_arp_speed == 1.0:
                arp_limit = 0

        arp_time += 1
        if arp_limit != 0 and arp_time >= arp_limit:
            arp_limit = 0
            fperiod *= arp_mod

        fslide += fdslide
        fperiod *= fslide
        if fperiod > fmaxperiod:
            fperiod = fmaxperiod
            if p.p_freq_limit > 0.0:
                playing = False

        rfperiod = fperiod
        if vib_amp > 0.0:
            vib_phase += vib_speed
            rfperiod = fperiod * (1.0 + math.sin(vib_phase) * vib_amp)
        period = int(rfperiod)
        if period < 8:
            period = 8

        square_duty += square_slide
        square_duty = min(0.5, max(0.0, square_duty))

        env_time += 1
        if env_time > env_length[env_stage]:
            env_time = 0
            env_stage += 1
            if env_stage == 3:
                playing = False
                break
        if env_stage == 0:
            env_vol = env_time / env_length[0]
        elif env_stage == 1:
            env_vol = 1.0 + (1.0 - env_time / env_length[1]) * 2.0 * p.p_env_punch
        else:
            env_vol = 1.0 - env_time / env_length[2]

        fphase += fdphase
        iphase = min(1023, abs(int(fphase)))

        if flthp_d != 0.0:
            flthp *= flthp_d
            flthp = min(0.1, max(0.00001, flthp))

        ssample = 0.0
        for _ in range(8):  # 8x supersampling
            phase += 1
            if phase >= period:
                phase %= period
                if p.wave_type == NOISE:
                    noise_buffer = [rng.random() * 2.0 - 1.0 for _ in range(32)]
            fp = phase / period
            if p.wave_type == SQUARE:
                sample = 0.5 if fp < square_duty else -0.5
            elif p.wave_type == SAWTOOTH:
                sample = 1.0 - fp * 2.0
            elif p.wave_type == SINE:
                sample = math.sin(fp * two_pi)
            else:  # NOISE
                sample = noise_buffer[(phase * 32 // period) & 31]

            # Low-pass filter.
            pp = fltp
            fltw *= fltw_d
            fltw = min(0.1, max(0.0, fltw))
            if p.p_lpf_freq != 1.0:
                fltdp += (sample - fltp) * fltw
                fltdp -= fltdp * fltdmp
            else:
                fltp = sample
                fltdp = 0.0
            fltp += fltdp
            # High-pass filter.
            fltphp += fltp - pp
            fltphp -= fltphp * flthp
            sample = fltphp
            # Phaser.
            phaser_buffer[ipp & 1023] = sample
            sample += phaser_buffer[(ipp - iphase + 1024) & 1023]
            ipp = (ipp + 1) & 1023

            ssample += sample * env_vol

        ssample = ssample / 8.0 * 2.0 * p.sound_vol
        out.append(max(-1.0, min(1.0, ssample)))

    return np.asarray(out, dtype=np.float32)


def render_wav(p: Params, path: str, sample_rate: int = SAMPLE_RATE,
               peak: float = 0.9) -> dict:
    """Synthesize `p`, peak-normalise to `peak`, write a 16-bit mono WAV.

    Returns a small stats dict (samples, duration_seconds, peak) for the
    manifest. Peak-normalising guarantees an audible file regardless of the
    parameter set's raw gain."""
    samples = synthesize(p, sample_rate)
    if samples.size == 0:
        samples = np.zeros(int(sample_rate * 0.05), dtype=np.float32)
    max_abs = float(np.max(np.abs(samples))) or 1.0
    samples = samples / max_abs * peak
    pcm = np.int16(np.clip(samples, -1.0, 1.0) * 32767)
    with wave.open(path, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(sample_rate)
        w.writeframes(pcm.tobytes())
    return {
        "samples": int(samples.size),
        "duration_seconds": round(samples.size / sample_rate, 3),
        "sample_rate": sample_rate,
        "channels": 1,
        "bit_depth": 16,
        "peak_normalized_to": peak,
    }
