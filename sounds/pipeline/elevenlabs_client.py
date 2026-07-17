"""ElevenLabs Sound Effects client — the optional *AI* engine for this domain.

ElevenLabs' text-to-sound-effects model is, as of 2026, the market leader for
turning a short text prompt into a realistic/foley game sound effect. It's a
hosted, paid API: this client is only activated when `ELEVENLABS_API_KEY` is set
(mirroring how the other domains gate on `PIXELLAB_API_KEY`). Without a key the
loop falls back to the free, offline procedural engine (`sfxr.py`).

Endpoint (see config/sounds.json → engine.ai):
    POST https://api.elevenlabs.io/v1/sound-generation
    headers: {"xi-api-key": KEY, "Content-Type": "application/json"}
    body:    {"text", "duration_seconds", "prompt_influence", "loop",
              "model_id", "output_format"}
    -> binary audio (mp3 by default)

Credits/quota are read from GET /v1/user/subscription so the loop can respect a
floor (budget.min_ai_credits_remaining) and never drain the account.
"""

from __future__ import annotations

import os

import requests

API_ROOT = "https://api.elevenlabs.io/v1"
GEN_URL = f"{API_ROOT}/sound-generation"
SUB_URL = f"{API_ROOT}/user/subscription"


class ElevenLabsError(RuntimeError):
    pass


class BudgetExhausted(RuntimeError):
    """Raised when remaining AI credits fall below the configured floor."""


class ElevenLabsClient:
    """Thin wrapper over the sound-generation endpoint. Instantiating without a
    key raises — callers should check `available()` first."""

    def __init__(self, api_key: str | None = None, timeout: int = 120):
        self.api_key = api_key or os.environ.get("ELEVENLABS_API_KEY")
        if not self.api_key:
            raise ElevenLabsError("ELEVENLABS_API_KEY is not set")
        self.timeout = timeout
        self.session = requests.Session()
        self.session.headers.update({"xi-api-key": self.api_key})

    @staticmethod
    def available() -> bool:
        return bool(os.environ.get("ELEVENLABS_API_KEY"))

    @staticmethod
    def parse_format(output_format: str) -> tuple[bool, int]:
        """(is_pcm, sample_rate) for an ElevenLabs output_format string, e.g.
        'pcm_48000' -> (True, 48000), 'mp3_44100_128' -> (False, 44100)."""
        parts = output_format.split("_")
        is_pcm = parts[0] == "pcm"
        sr = 48000
        for p in parts[1:]:
            if p.isdigit() and int(p) >= 8000:
                sr = int(p)
                break
        return is_pcm, sr

    def generate(self, text: str, *, duration_seconds: float | None = None,
                 prompt_influence: float = 0.5, loop: bool = False,
                 model_id: str = "eleven_text_to_sound_v2",
                 output_format: str = "pcm_48000") -> bytes:
        """Return raw audio bytes for `text`. `duration_seconds` in [0.5, 30]; when
        None the model picks a natural length. Default `pcm_48000` is lossless
        48 kHz (Pro tier) for AAA delivery; raw PCM is wrapped into WAV by the
        caller."""
        body: dict = {
            "text": text,
            "prompt_influence": prompt_influence,
            "loop": loop,
            "model_id": model_id,
            "output_format": output_format,
        }
        if duration_seconds is not None:
            body["duration_seconds"] = max(0.5, min(30.0, float(duration_seconds)))
        r = self.session.post(GEN_URL, json=body, timeout=self.timeout)
        if r.status_code != 200:
            raise ElevenLabsError(f"sound-generation {r.status_code}: {r.text[:300]}")
        if not r.content:
            raise ElevenLabsError("sound-generation returned empty body")
        return r.content

    def credits_remaining(self) -> int | None:
        """character_count vs character_limit -> remaining credits, or None if the
        subscription endpoint is unavailable (treated as 'unknown, proceed')."""
        try:
            r = self.session.get(SUB_URL, timeout=self.timeout)
            if r.status_code != 200:
                return None
            d = r.json()
            limit = d.get("character_limit")
            used = d.get("character_count")
            if isinstance(limit, int) and isinstance(used, int):
                return max(0, limit - used)
        except (requests.RequestException, ValueError):
            return None
        return None

    def ensure_budget(self, floor: int) -> None:
        rem = self.credits_remaining()
        if rem is not None and rem < floor:
            raise BudgetExhausted(f"AI credits {rem} < floor {floor}")
