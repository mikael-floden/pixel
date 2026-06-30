"""Thin PixelLab API client. STUBBED — every network call is a clear TODO.

Auth model (verify against PixelLab docs before going live): Bearer token from
the PIXELLAB_API_KEY env var, base URL https://api.pixellab.ai/v2. Nothing here
performs a real request yet; methods raise NotImplementedError so generators can
wire the deterministic pipeline now and drop real calls in during Phase 0.
"""

from __future__ import annotations

import os

import requests  # noqa: F401  (used once the TODOs below are implemented)

BASE_URL = "https://api.pixellab.ai/v2"
API_KEY_ENV = "PIXELLAB_API_KEY"


class PixelLabError(RuntimeError):
    pass


class PixelLabClient:
    def __init__(self, api_key=None, base_url=BASE_URL, timeout=120):
        self.api_key = api_key or os.environ.get(API_KEY_ENV)
        self.base_url = base_url.rstrip("/")
        self.timeout = timeout

    # -- internals -----------------------------------------------------------

    def require_key(self):
        if not self.api_key:
            raise PixelLabError(
                f"{API_KEY_ENV} is not set. Export your PixelLab key before "
                f"running any generator that calls the API."
            )

    def _headers(self):
        self.require_key()
        # TODO(phase0): confirm PixelLab expects Bearer auth and this header set.
        return {
            "Authorization": f"Bearer {self.api_key}",
            "Accept": "application/json",
        }

    def _post(self, path, payload):
        self.require_key()
        # TODO(phase0): implement once egress to api.pixellab.ai is allowed:
        #   url = f"{self.base_url}/{path.lstrip('/')}"
        #   resp = requests.post(url, json=payload, headers=self._headers(),
        #                        timeout=self.timeout)
        #   resp.raise_for_status()
        #   return resp.json()
        raise NotImplementedError(
            f"PixelLab POST /{path} is stubbed. Wire it in Phase 0 once the key "
            f"is set and api.pixellab.ai egress is allowed."
        )

    # -- public surface (all stubbed) ---------------------------------------

    def generate_image(self, prompt, w, h, style_ref=None, n_colors=None):
        """Text/style -> a single pixel-art image. TODO: real endpoint + decode."""
        return self._post("generate-image", {
            "prompt": prompt, "width": w, "height": h,
            "style_ref": style_ref, "n_colors": n_colors,
        })

    def animate_skeleton(self, image, keypoints, **kw):
        """Re-pose an image along skeleton keypoints. TODO: endpoint + payload."""
        return self._post("animate-skeleton", {
            "image": image, "keypoints": keypoints, **kw,
        })

    def animate_text(self, image, action, **kw):
        """Animate an image from a text action ('walk', 'kick'...). TODO."""
        return self._post("animate-text", {
            "image": image, "action": action, **kw,
        })

    def remove_background(self, image, **kw):
        """Cut to transparent background. TODO: endpoint + payload."""
        return self._post("remove-background", {"image": image, **kw})

    def reduce_colors(self, image, n_colors, **kw):
        """Quantize to n_colors. TODO: endpoint + payload."""
        return self._post("reduce-colors", {
            "image": image, "n_colors": n_colors, **kw,
        })

    def transfer_outfit(self, image, outfit_ref, **kw):
        """Apply a gear/outfit reference onto a base sprite. TODO."""
        return self._post("transfer-outfit", {
            "image": image, "outfit_ref": outfit_ref, **kw,
        })
