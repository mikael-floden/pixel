// A built-in, art-free "Wanderer" so the game is always playable — even when the
// character roster is empty (the art agents periodically reset/regenerate it) or
// when a stored character's art has been removed. The sprite is drawn
// procedurally at runtime (see WorldScene.ensurePlaceholderTexture); the select
// portrait is an inline SVG so it needs no network asset.
import { CharacterDef } from "./manifest";

export const PLACEHOLDER_UID = "__placeholder__";

export function isPlaceholder(uid: string | undefined): boolean {
  return uid === PLACEHOLDER_UID;
}

/** A pickable character backed by no external files (empty `animations`). */
export function placeholderCharacter(): CharacterDef {
  return {
    uid: PLACEHOLDER_UID,
    skeleton: "__builtin__",
    id: "placeholder",
    name: "Wanderer",
    root: "",
    portrait: PLACEHOLDER_PORTRAIT,
    frameW: 32,
    frameH: 48,
    animations: {}, // nothing to load; the renderer draws it procedurally
  };
}

/** Ensure there is always at least one selectable character. */
export function withFallback(characters: CharacterDef[]): CharacterDef[] {
  return characters.length ? characters : [placeholderCharacter()];
}

/**
 * Stable, pleasant color for a name/id so multiple placeholder wanderers (all
 * named "Wanderer" when the roster is empty) are still visually distinct.
 * Returns a 0xRRGGBB int.
 */
export function colorForName(seed: string): number {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  const hue = (h >>> 0) % 360;
  return hslToInt(hue, 60, 62);
}

function hslToInt(h: number, s: number, l: number): number {
  s /= 100;
  l /= 100;
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  let r = 0;
  let g = 0;
  let b = 0;
  if (h < 60) [r, g, b] = [c, x, 0];
  else if (h < 120) [r, g, b] = [x, c, 0];
  else if (h < 180) [r, g, b] = [0, c, x];
  else if (h < 240) [r, g, b] = [0, x, c];
  else if (h < 300) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];
  const to = (v: number) => Math.round((v + m) * 255);
  return (to(r) << 16) | (to(g) << 8) | to(b);
}

// A small hooded wanderer, matching the procedural in-world sprite. Inline SVG
// keeps the select grid working with zero network requests.
const PLACEHOLDER_PORTRAIT =
  "data:image/svg+xml;utf8," +
  encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" width="72" height="72" viewBox="0 0 32 32" shape-rendering="crispEdges">
       <rect width="32" height="32" fill="#1e1e30"/>
       <rect x="11" y="6" width="10" height="9" fill="#f1c9a5"/>
       <rect x="10" y="4" width="12" height="4" fill="#3b3b57"/>
       <rect x="10" y="14" width="12" height="12" fill="#5a7bd6"/>
       <rect x="9" y="15" width="2" height="8" fill="#4a68bd"/>
       <rect x="21" y="15" width="2" height="8" fill="#4a68bd"/>
       <rect x="11" y="26" width="4" height="4" fill="#2a2a44"/>
       <rect x="17" y="26" width="4" height="4" fill="#2a2a44"/>
     </svg>`,
  );
