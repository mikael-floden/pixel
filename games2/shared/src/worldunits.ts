// worldunits.ts — POSITIONS ON THE WIRE (spec/ZONES.md; maintainer 2026-09-09:
// "sending shorts instead of floats").
//
// A body's position is synced as `px`/`py`: int16, quarter world units,
// relative to the ROOM's origin (`state.ox`, `state.oy`; `state.pq` units per
// world unit). Two bytes an axis instead of five, and any map size: a zone is
// 99 cells and its ghosts reach 36 past the edge, so every entity a room
// holds lies within ~5,500 wu of its origin — 22,000 quarter units of the
// 32,767 an int16 holds. (The whole-world room, tests only, uses half units.)
//
// Nothing else changes: the server keeps float `x`/`y` on every entity and
// writes px/py before each patch; the CLIENT reads `x`/`y` through getters
// installed on the schema base class, which walk up to the room state for the
// origin and the scale. Server instances shadow the getters with their own
// `x`/`y` properties, so one installer serves both sides.

export const POS_Q_ZONE = 4; // quarter units in a zone room
export const POS_Q_WHOLE = 2; // half units in the whole-world room (394 cells x 32 x 2 fits int16)

export function quantizePos(v: number, origin: number, q: number): number {
  const n = Math.round((v - origin) * q);
  return n < -32768 ? -32768 : n > 32767 ? 32767 : n;
}

/** Install `x`/`y` getters on the schema base class: `state.ox + px / state.pq`.
 *  A client-decoded instance carries no link to its state, so the client's
 *  `Decoder` is hooked: every reference its tracker adds is remembered with
 *  the state it belongs to (a WeakMap, one entry per decoded object). Both
 *  classes are passed in so this file stays free of the dependency. A setter
 *  defines an own property, which is what a server-side instance's class
 *  field does anyway (server instances therefore shadow the getters).
 *  Idempotent. */
export function installWorldUnitAccessors(SchemaClass: { prototype: any }, DecoderClass: { prototype: any }): void {
  const proto = SchemaClass.prototype;
  if (Object.getOwnPropertyDescriptor(proto, "x")) return;
  const rootOf = new WeakMap<object, any>();
  const dproto = DecoderClass.prototype;
  const origSetState = dproto.setState;
  dproto.setState = function (this: any, root: any) {
    origSetState.call(this, root);
    const tracker = this.root;
    if (!tracker || typeof tracker.addRef !== "function") return;
    const add = tracker.addRef.bind(tracker);
    tracker.addRef = (refId: number, ref: any, inc?: boolean) => {
      add(refId, ref, inc);
      if (ref && typeof ref === "object") rootOf.set(ref, root);
    };
  };
  const define = (name: "x" | "y", q: "px" | "py", o: "ox" | "oy") =>
    Object.defineProperty(proto, name, {
      configurable: true,
      enumerable: false,
      get(this: any) {
        const v = this[q];
        if (typeof v !== "number") return undefined;
        const root = rootOf.get(this);
        const pq = typeof root?.pq === "number" && root.pq > 0 ? root.pq : POS_Q_ZONE;
        return (root?.[o] ?? 0) + v / pq;
      },
      set(this: any, v: number) {
        Object.defineProperty(this, name, { value: v, writable: true, enumerable: true, configurable: true });
      },
    });
  define("x", "px", "ox");
  define("y", "py", "oy");
}
