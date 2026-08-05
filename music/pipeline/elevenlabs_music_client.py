"""ElevenLabs Music client — composes full background-music tracks.

ElevenLabs Music (model `music_v1`, launched 2025) is, as of 2026, the
strongest promptable text-to-music API for cinematic/orchestral game scores.
Like every AI engine in this repo it is gated on a key (mirrors how `sounds/`
gates on the same account): `ELEVENLABS_API_KEY` (the legacy spelling
`ELEVEN_LABS_API_KEY` is accepted too).

Endpoints used:

    POST /v1/music/plan
        {"prompt", "music_length_ms", "model_id"}
        -> a *composition plan*: global styles + an ordered list of sections,
           each with a name, local style descriptors and an exact duration_ms.
           The plan is the GROUND-TRUTH TIMELINE for metadata.json: when we
           compose *from* the plan, section boundaries are known to the
           millisecond without audio analysis.

    POST /v1/music?output_format=...
        {"composition_plan"} or {"prompt", "music_length_ms"}, + "model_id"
        -> binary audio. `pcm_44100` (lossless, paid tier) preferred; falls
           back to `mp3_44100_128` when the lossless format is rejected.

Credits are the same character pool as the SFX endpoint; the loop respects a
floor (budget.min_ai_credits_remaining) so music never starves `sounds/`.

The REST API has used both snake_case and camelCase spellings for composition
plan fields; `plan_sections()` normalizes either shape.
"""

from __future__ import annotations

import os

import requests

API_ROOT = "https://api.elevenlabs.io/v1"
PLAN_URL = f"{API_ROOT}/music/plan"
COMPOSE_URL = f"{API_ROOT}/music"
SUB_URL = f"{API_ROOT}/user/subscription"


class ElevenLabsMusicError(RuntimeError):
    pass


class PlanUnavailable(ElevenLabsMusicError):
    """The /music/plan endpoint rejected the request — compose from the raw
    prompt instead (section timing then comes from audio analysis only)."""


class BudgetExhausted(RuntimeError):
    """Raised when remaining AI credits fall below the configured floor."""


def _env_key() -> str | None:
    return os.environ.get("ELEVENLABS_API_KEY") or os.environ.get("ELEVEN_LABS_API_KEY")


def _get(d: dict, *names, default=None):
    """Read the first present key from snake_case/camelCase variants."""
    for n in names:
        if isinstance(d, dict) and n in d:
            return d[n]
    return default


def plan_sections(plan: dict) -> list[dict]:
    """Normalize a composition plan's sections to
    [{"name", "duration_ms", "styles": [...]}, ...] regardless of casing."""
    out = []
    for sec in _get(plan, "sections", default=[]) or []:
        out.append({
            "name": _get(sec, "section_name", "sectionName", default="section"),
            "duration_ms": int(_get(sec, "duration_ms", "durationMs", default=0)),
            "styles": list(_get(sec, "positive_local_styles", "positiveLocalStyles",
                                default=[]) or []),
        })
    return out


class ElevenLabsMusicClient:
    """Thin wrapper over the music endpoints. Instantiating without a key
    raises — callers should check `available()` first."""

    FALLBACK_FORMAT = "mp3_44100_128"

    def __init__(self, api_key: str | None = None, timeout: int = 600):
        self.api_key = api_key or _env_key()
        if not self.api_key:
            raise ElevenLabsMusicError("ELEVENLABS_API_KEY is not set")
        self.timeout = timeout
        self.session = requests.Session()
        self.session.headers.update({"xi-api-key": self.api_key})

    @staticmethod
    def available() -> bool:
        return bool(_env_key())

    # -- composition plan ----------------------------------------------------

    def plan(self, prompt: str, music_length_ms: int,
             model_id: str = "music_v1") -> dict:
        body = {"prompt": prompt, "music_length_ms": int(music_length_ms),
                "model_id": model_id}
        r = self.session.post(PLAN_URL, json=body, timeout=self.timeout)
        if r.status_code != 200:
            raise PlanUnavailable(f"music/plan {r.status_code}: {r.text[:300]}")
        try:
            plan = r.json()
        except ValueError as e:
            raise PlanUnavailable(f"music/plan returned non-JSON: {e}")
        if not plan_sections(plan):
            raise PlanUnavailable("music/plan returned no sections")
        return plan

    # -- compose -------------------------------------------------------------

    def compose(self, *, prompt: str | None = None,
                composition_plan: dict | None = None,
                music_length_ms: int | None = None,
                model_id: str = "music_v1",
                output_format: str = "pcm_44100") -> bytes:
        """Return raw audio bytes. Pass EITHER `composition_plan` (durations come
        from the plan) OR `prompt` (+ `music_length_ms`)."""
        body: dict = {"model_id": model_id}
        if composition_plan is not None:
            body["composition_plan"] = composition_plan
        else:
            if not prompt:
                raise ElevenLabsMusicError("compose needs a prompt or a composition_plan")
            body["prompt"] = prompt
            if music_length_ms is not None:
                body["music_length_ms"] = int(music_length_ms)
        r = self.session.post(COMPOSE_URL, params={"output_format": output_format},
                              json=body, timeout=self.timeout)
        if r.status_code != 200:
            raise ElevenLabsMusicError(f"music {r.status_code}: {r.text[:300]}")
        if not r.content:
            raise ElevenLabsMusicError("music returned an empty body")
        return r.content

    def compose_best(self, *, primary_format: str, **kw) -> tuple[bytes, str]:
        """Compose at `primary_format`; if the tier rejects it (lossless PCM may
        need a higher subscription) degrade once to MP3 rather than failing the
        run. NOTE: the API may DELIVER a different container than requested with
        a 200 OK — callers must sniff the actual bytes, not trust the returned
        format string."""
        try:
            return self.compose(output_format=primary_format, **kw), primary_format
        except ElevenLabsMusicError as e:
            if isinstance(e, PlanUnavailable) or self.FALLBACK_FORMAT == primary_format:
                raise
            print(f"  ! {primary_format} rejected ({str(e)[:100]}); "
                  f"falling back to {self.FALLBACK_FORMAT}")
            return self.compose(output_format=self.FALLBACK_FORMAT, **kw), self.FALLBACK_FORMAT

    # -- budget --------------------------------------------------------------

    def credits_remaining(self) -> int | None:
        try:
            r = self.session.get(SUB_URL, timeout=60)
            if r.status_code != 200:
                return None
            d = r.json()
            limit, used = d.get("character_limit"), d.get("character_count")
            if isinstance(limit, int) and isinstance(used, int):
                return max(0, limit - used)
        except (requests.RequestException, ValueError):
            return None
        return None

    def ensure_budget(self, floor: int) -> None:
        rem = self.credits_remaining()
        if rem is not None and rem < floor:
            raise BudgetExhausted(f"AI credits {rem} < floor {floor}")
