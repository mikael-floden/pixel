// World-unit scale — the ONE primitive constant that both the barrel index.ts
// and the leaf modules it re-exports (monsters.ts) need at MODULE-INIT time.
//
// It lives in this dependency-free leaf so `monsters.ts` can read it WITHOUT
// importing the `./index` barrel. index.ts re-exports `monsters.ts` at the end
// of its body, so if `monsters.ts` imported `CELL_WU` from `./index` (a cycle),
// `monsters.ts` would evaluate before index.ts's body initialized `CELL_WU`,
// crashing on a temporal-dead-zone `ReferenceError` when it built SPAWN_AREAS.
// Sourcing it from this leaf breaks that cycle; index.ts re-exports it so the
// public `@nangijala/shared` surface is unchanged.

// World units: a FIXED 32 per map cell (CELL_WU). A world's extent is therefore
// grid×CELL_WU — derived per-world (worldWidthOf/worldHeightOf), NOT a global
// constant. Every grid↔world conversion (surfaceAtWorld, findSpawn, the client's
// project()) divides by CELL_WU, so worlds of any dimensions render + collide
// correctly and the server can host several differently-sized worlds at once.
export const CELL_WU = 32;
