import Phaser from "phaser";
import { Room, getStateCallbacks } from "colyseus.js";
import {
  WORLD_WIDTH,
  WORLD_HEIGHT,
  CELL_WU,
  DIRECTIONS,
  DEFAULT_DIRECTION,
  InputMessage,
  ChatBroadcast,
  stepMovement,
  vectorToDirection,
  TerrainGrid,
  buildTerrainGrid,
  makeBlocked,
  makeDrops,
  surfaceAtWorld,
  levelAtWorld,
  isStandableAtWorld,
  findSpawn,
  surfaceFor,
  isKnownSurface,
  WALK_CLIMB,
  JUMP_CLIMB,
  JUMP_SPEED_FACTOR,
  JUMP_MS,
  JUMP_COOLDOWN_MS,
  MAX_STAMINA,
} from "@nangijala/shared";
import { CharacterDef, Manifest, stripUrl } from "../manifest";
import { colorForName } from "../placeholder";
import { Atmosphere, LightSource } from "../lighting";
import {
  NightLights,
  ShaderLight,
  MAX_SHADER_LIGHTS,
  EmissionMap,
  GlowStamp,
  buildGlowStamps,
} from "../nightlight";
import { joinWorld } from "../net";
import { ChatUI } from "../chat";
import { RosterUI } from "../roster";
import {
  World,
  MAP_GEOMETRY,
  tileKey,
  tileUrl,
  distinctTiles,
  drawOrder,
  canvasSize,
} from "../maps";

const ANIM_FPS: Record<string, number> = { idle: 6, walk: 12, run: 14 };
// Spawn campfire (objects/campfire, burn/south): 96px frames; per its
// placement metadata the fire is 0.6m ≈ 23px tall vs a 64px character, and
// the drawn logs span rows 15..83 of the frame → scale + base anchor below.
const CAMPFIRE_KEY = "campfire-burn";
const CAMPFIRE_URL = "/assets/objects/campfire/animations/burn__south.png";
const CAMPFIRE_FRAME = 96;
const CAMPFIRE_FRAMES = 17;
const CAMPFIRE_SCALE = 42 / 68;
const CAMPFIRE_BASE = 83 / 96;
const INPUT_HZ = 20;
const BUBBLE_MS = 5000;
const PLACEHOLDER_TEX = "placeholder:wanderer";
const SHADOW_TEX = "avatar:shadow";
// Tile self-emission is data-driven: tiles/emission.json (owned by the tiles
// agent — every category has an entry, null = does not glow). Each glowing
// category gets (a) a self-glow FLOOR on its own pixels (shader, nightlight.ts)
// and (b) a small SHADOW-FREE glow pool around it. Pools are clustered per
// EMISSION_BUCKET-cell bucket so a whole lava lake becomes a few soft pools
// instead of hundreds of point lights, and only the nearest EMISSION_POOL_MAX
// clusters feed the shader (the rest still glow via the self floor).
const MAX_EMISSIVE = 48; // atmosphere blooms per view (canvas fallback, perf)
const EMISSION_BUCKET = 3; // cells per cluster bucket side
const EMISSION_POOL_MAX = 8; // shader glow pools per view (top + face pools)
// Time-of-day cycle ([1] cycles, ~2.5s smooth interpolation between phases).
// Each phase is ONLY an ambient grade (what unlit art is multiplied by) —
// point lights are never phase-tuned (a light is a light; daylight drowns
// fire pools naturally because the multiply clamps near full brightness).
// NIGHT is the calibrated reference — its values must never drift. The other
// grades are first passes from the Sea of Stars reference stills, tuned one
// phase at a time with the playtester (morning next).
const TIME_PHASES: { name: string; ambient: [number, number, number] }[] = [
  // Calibrated night: dark, desaturated, mild blue tilt.
  { name: "Night", ambient: [0.075, 0.09, 0.14] },
  // Rosy dawn: as dark as evening but PINK-red (B stays up) — vs evening's
  // orange-amber. Playtester: "the famous reddish tint we all love".
  { name: "Morning", ambient: [0.61, 0.43, 0.4] },
  // Ref: the art as authored — neutral, full brightness.
  { name: "Day", ambient: [1.0, 1.0, 1.0] },
  // Amber sunset, dimmed — same hue as before, ~78% the brightness.
  { name: "Evening", ambient: [0.74, 0.55, 0.37] },
];
const TIME_TRANSITION_S = 2.5;

// Lit copies (see applyObjectLights) live in a thin band ABOVE the darkness
// overlay (depth 900_000) but must keep the world's relative draw order among
// themselves — a character in front of the fire must cover the fire's lit copy
// too. Base depths are screen-y scalars (< ~20k px), compressed into the band.
const litDepth = (baseDepth: number) => 900_001 + baseDepth * 1e-5;
const JUMP_HEIGHT = 28; // px peak of the jump hop (a tall, floaty arc)
const SWIM_SINK = 6; // px the sprite sinks while swimming
const GROUND_MARGIN = 512; // extra ground drawn beyond the screen (px per side)

interface Avatar {
  sprite: Phaser.GameObjects.Sprite;
  shadow: Phaser.GameObjects.Image;
  label: Phaser.GameObjects.Text;
  character: string;
  // Logical (eased) ground position; the sprite is drawn at this minus the jump
  // hop so the hop offset never feeds back into the easing.
  lx: number;
  ly: number;
  // Flat authoritative world position (pre-projection) — terrain queries and
  // the night-shader lights need THIS space, never the projected lx/ly.
  fx: number;
  fy: number;
  lit?: Phaser.GameObjects.Sprite; // lit copy above the night overlay
  // Screen y of the highest wall top drawn over the sprite this frame, or
  // undefined when nothing covers it — the lit copy is cropped BELOW this line.
  coverY?: number;
  hopUntil: number;
  swimming: boolean;
  baseTint: number;
  bubble?: Phaser.GameObjects.Text;
  bubbleUntil?: number;
}

export class WorldScene extends Phaser.Scene {
  private manifest!: Manifest;
  private myCharacter!: CharacterDef;
  private myName!: string;
  private room?: Room;
  private avatars = new Map<string, Avatar>();
  private keys!: Record<string, Phaser.Input.Keyboard.Key>;
  private lastSent = "";
  private chat!: ChatUI;
  private roster = new RosterUI();
  // Client-side prediction state (local player).
  private pending: { seq: number; ax: number; ay: number; running: boolean; dt: number }[] = [];
  private inputSeq = 0;
  private sendAccum = 0;
  private lastInput: { ax: number; ay: number; running: boolean } = { ax: 0, ay: 0, running: false };
  // Isometric tile world (null → fall back to a plain ground).
  private world: World | null = null;
  private iso = { ox: 0, oy: 0, w: WORLD_WIDTH, h: WORLD_HEIGHT };
  // Terrain (elevation + surface) — same grid the server uses, so prediction matches.
  private terrain: TerrainGrid | null = null;
  private collisionOverlay?: Phaser.GameObjects.Graphics;
  // Streaming ground renderer state.
  private groundRT?: Phaser.GameObjects.RenderTexture;
  private lastGround = { x: NaN, y: NaN };
  private maxLevel = 0;
  // Occlusion: raised/solid tiles near the camera drawn as depth-sorted images
  // so they cover characters standing BEHIND them (the ground RT is flat).
  private occluders: Phaser.GameObjects.Image[] = [];
  private occluderMeta: {
    col: number;
    row: number;
    top: number; // column's top level
    depth: number;
    x0: number;
    x1: number;
    y0: number;
    y1: number;
  }[] = [];
  private lastOccl = { x: NaN, y: NaN };
  private emissiveLights: LightSource[] = [];
  // Local jump prediction (client owns its jump timing).
  private jumpUntil = 0;
  private jumpReadyAt = 0;
  private jumpQueued = false;
  private staminaBar?: Phaser.GameObjects.Graphics;
  // It is ALWAYS night in Nangijala (for now): the per-pixel shader when
  // WebGL is available, the multiply grade as the canvas fallback.
  private atmo!: Atmosphere;
  private night?: NightLights;
  private shaderLights: ShaderLight[] = [];
  // tiles/emission.json categories (empty when the registry failed to load).
  private emission: EmissionMap = {};
  // Per-pixel glow halos for the visible window (rebuilt with the occluders).
  private glowStamps: GlowStamp[] = [];
  // The spawn campfire: an animated world object with its own fire light.
  private campfire?: { col: number; row: number; z: number; x: number; y: number; depth: number };
  private campfireSprite?: Phaser.GameObjects.Sprite;
  private campfireLit?: Phaser.GameObjects.Sprite;
  // [5] toggles the LOCAL player's hand torch (handy for judging fixed lights).
  private torchOn = true;
  // Debug-only extra light, set from __ml.probeLight for headless probes.
  private probeLight: ShaderLight | null = null;
  // Time-of-day state: target phase index + eased interpolation FROM whatever
  // grade is currently on screen (mid-transition retargets stay smooth).
  private timeIdx = 0;
  private timeT = 1; // 0..1 progress toward TIME_PHASES[timeIdx]
  private timeStart = 0; // wall-clock ms when the transition began
  private timeFromAmbient: [number, number, number] = [...TIME_PHASES[0].ambient];
  private curAmbient: [number, number, number] = [...TIME_PHASES[0].ambient];

  constructor() {
    super("world");
  }

  init() {
    this.manifest = this.registry.get("manifest") as Manifest;
    this.myCharacter = this.registry.get("character") as CharacterDef;
    this.myName = this.registry.get("name") as string;
    this.world = (this.registry.get("world") as World | null) ?? null;
    if (this.world) {
      this.terrain = buildTerrainGrid(this.world.width, this.world.height, this.world.rows);
      // Surface-contract watchdog: categories missing from SURFACES default
      // to walkable ground, which ALSO makes the night lighting treat them
      // as terrain (walls + face shadows) instead of solid objects (art +
      // soft cast shadow). Surface it loudly so the loop adds new categories.
      const unknown = new Set<string>();
      for (const row of this.world.rows) for (const c of row) if (!isKnownSurface(c.t)) unknown.add(c.t);
      if (unknown.size)
        console.warn(
          `[nangijala] ${unknown.size} tile categories missing from SURFACES (defaulting to plain ground — night shadows may misclassify them):`,
          [...unknown].sort().join(", "),
        );
    }
  }

  preload() {
    // Load every character's movement strips as spritesheets (few requests).
    for (const def of this.manifest.characters) {
      for (const [anim, dirs] of Object.entries(def.animations)) {
        for (const dir of Object.keys(dirs)) {
          this.load.spritesheet(sheetKey(def.uid, anim, dir), stripUrl(def, anim, dir), {
            frameWidth: def.frameW,
            frameHeight: def.frameH,
          });
        }
      }
    }
    // Isometric ground tiles the world uses.
    if (this.world) {
      for (const { t, v } of distinctTiles(this.world)) {
        this.load.image(tileKey(t, v), tileUrl(t, v));
      }
      // Self-emission registry (which categories glow, how) — tiles agent's.
      this.load.json("tile-emission", "/assets/tiles/emission.json");
      this.load.spritesheet(CAMPFIRE_KEY, CAMPFIRE_URL, {
        frameWidth: CAMPFIRE_FRAME,
        frameHeight: CAMPFIRE_FRAME,
      });
    }
  }

  async create() {
    this.ensurePlaceholderTexture();
    this.ensureShadowTexture();
    this.ensureShadeTextures();
    this.buildAnimations();
    if (this.world) this.setupStreamingGround();
    else this.drawGround();
    this.placeCampfire();

    this.atmo = new Atmosphere(this);
    this.atmo.create();
    this.atmo.setPreset("night");
    // Shader night needs WebGL; on canvas renderers the multiply grade
    // remains the night fallback.
    const emissionData = this.cache.json.get("tile-emission") as
      | { categories?: EmissionMap }
      | undefined;
    this.emission = emissionData?.categories ?? {};
    if (!emissionData)
      console.warn("[nangijala] tiles/emission.json missing — tile self-emission disabled");
    if (this.world && this.game.renderer.type === Phaser.WEBGL) {
      try {
        this.night = new NightLights(this, this.world, this.iso, this.maxLevel, this.emission);
        this.night.create();
      } catch (err) {
        console.warn("[nangijala] shader night unavailable:", err);
        this.night = undefined;
      }
      // The first ground window / occluders were drawn BEFORE this.night
      // existed and still carry the baked daylight contact shades — redraw
      // them so the night world uses per-pixel light only.
      if (this.night) {
        this.lastGround = { x: NaN, y: NaN };
        this.lastOccl = { x: NaN, y: NaN };
      }
    }

    // A resize grows the visible window: force the streamed ground,
    // occluders and glow stamps to rebuild for the new extent.
    this.scale.on("resize", () => {
      this.lastGround = { x: NaN, y: NaN };
      this.lastOccl = { x: NaN, y: NaN };
    });

    this.keys = this.input.keyboard!.addKeys(
      "W,A,S,D,UP,DOWN,LEFT,RIGHT,SHIFT",
    ) as Record<string, Phaser.Input.Keyboard.Key>;

    // Chat: Enter opens the input; while typing, Phaser keyboard is disabled so
    // movement keys don't leak through, and re-enabled when the box closes.
    this.chat = new ChatUI(
      (text) => this.room?.send("chat", { text }),
      () => (this.input.keyboard!.enabled = true),
    );
    this.input.keyboard!.on("keydown-ENTER", () => {
      if (!this.chat.open) {
        this.input.keyboard!.enabled = false;
        this.chat.openInput();
      }
    });
    // Jump (Space): edge-triggered, lets you cross a 1-level ledge if timed.
    this.input.keyboard!.on("keydown-SPACE", () => this.tryJump());
    // [0]: the emission demo world — every glowing tile, numbered.
    this.input.keyboard!.on("keydown-ZERO", () => {
      location.hash = "#emission";
      location.reload();
    });
    // Feature/debug toggles live on the TOP-ROW digits (1-9).
    this.input.keyboard!.on("keydown-ONE", () => {
      this.setTimeOfDay((this.timeIdx + 1) % TIME_PHASES.length);
      this.chat.addLog("—", `[1] Time of day: ${TIME_PHASES[this.timeIdx].name}`);
    });
    this.input.keyboard!.on("keydown-FOUR", () => {
      this.toggleCollisionOverlay();
      this.chat.addLog("—", `[4] Collision overlay: ${this.collisionOverlay ? "on" : "off"}`);
    });
    this.input.keyboard!.on("keydown-FIVE", () => {
      this.torchOn = !this.torchOn;
      this.chat.addLog("—", `[5] My torch: ${this.torchOn ? "on" : "off"}`);
    });
    // Light-field calibration keys: flip/scale the field live and a raw
    // gradient test pattern — ground truth beats screenshot interpretation.
    this.input.keyboard!.on("keydown-SIX", () => {
      if (!this.night) return;
      this.night.fieldFlip = this.night.fieldFlip ? 0 : 1;
      this.chat.addLog("—", `[6] Field y-invert: ${this.night.fieldFlip}`);
    });
    this.input.keyboard!.on("keydown-SEVEN", () => {
      if (!this.night) return;
      this.night.overlayFlip = !this.night.overlayFlip;
      this.chat.addLog("—", `[7] Overlay mirror: ${this.night.overlayFlip ? "on" : "off"}`);
    });
    this.input.keyboard!.on("keydown-EIGHT", () => {
      if (!this.night) return;
      const order = [1, 0.5, 2, 4];
      this.night.spanScale = order[(order.indexOf(this.night.spanScale) + 1) % order.length];
      this.chat.addLog("—", `[8] Field span x${this.night.spanScale}`);
    });
    this.input.keyboard!.on("keydown-NINE", () => {
      if (!this.night) return;
      this.night.testPattern = (this.night.testPattern + 1) % 5;
      const names = [
        "off",
        "gradient (dark = TOP if correct)",
        "cell grid (must match tile edges)",
        "raw fragment uv",
        "surface class (face RED / top GREEN)",
      ];
      this.chat.addLog("—", `[9] Field test: ${names[this.night.testPattern]}`);
    });
    this.chat.addLog("—", "Toggles: [1] time of day · [4] collision · [5] torch · [0] emission demo · [6][7][8][9] light-field calibration");

    const cam = this.cameras.main;
    cam.setBounds(0, 0, this.iso.w, this.iso.h);
    // 2× integer zoom: closer view, still crisp (nearest-neighbour, no
    // fractional scaling of the pixel art).
    cam.setZoom(2);
    cam.setBackgroundColor(this.world ? "#181c28" : "#1b3327");

    try {
      this.room = await joinWorld({ name: this.myName, character: this.myCharacter.uid });
    } catch (err) {
      this.showConnectionError(err);
      return;
    }

    const $ = getStateCallbacks(this.room);
    $(this.room.state).players.onAdd((player: any, id: string) => {
      this.addAvatar(id, player);
      if (id === this.room!.sessionId) {
        const av = this.avatars.get(id)!;
        cam.startFollow(av.sprite, true, 0.15, 0.15);
      }
      this.refreshRoster();
    });
    $(this.room.state).players.onRemove((_player: any, id: string) => {
      const av = this.avatars.get(id);
      if (av) {
        av.sprite.destroy();
      av.lit?.destroy();
        av.shadow.destroy();
        av.label.destroy();
        av.bubble?.destroy();
        this.avatars.delete(id);
      }
      this.refreshRoster();
    });

    this.room.onMessage("chat", (msg: ChatBroadcast) => {
      this.chat.addLog(msg.name, msg.text);
      this.showBubble(msg.id, msg.text);
    });

    this.room.onMessage("drown", (msg: { id: string; name: string }) => {
      this.showBubble(msg.id, "blub… 🫧");
      this.chat.addLog("—", `${msg.name} nearly drowned and washed ashore.`);
    });

    // Debug hooks for headless end-to-end verification.
    (window as any).__ml = {
      players: () => this.avatars.size,
      myId: () => this.room?.sessionId,
      myX: () => {
        const id = this.room?.sessionId;
        const av = id ? this.avatars.get(id) : undefined;
        return av ? av.sprite.x : null;
      },
      myCharacter: () => {
        const id = this.room?.sessionId;
        const av = id ? this.avatars.get(id) : undefined;
        return av ? av.character : null;
      },
      say: (text: string) => this.room?.send("chat", { text }),
      bubbles: () => [...this.avatars.values()].filter((a) => a.bubble).map((a) => a.bubble!.text),
      jump: () => this.tryJump(),
      me: () => this.room?.state.players.get(this.room!.sessionId),
      stamina: () => this.room?.state.players.get(this.room!.sessionId)?.stamina ?? null,
      swimming: () => !!this.room?.state.players.get(this.room!.sessionId)?.swimming,
      surfaceAt: (x: number, y: number) => (this.terrain ? surfaceAtWorld(this.terrain, x, y) : null),
      levelAt: (x: number, y: number) => (this.terrain ? levelAtWorld(this.terrain, x, y) : 0),
      nightShader: () => !!this.night && this.night.active,
      // Get/set the time-of-day phase (by index or name); instant when set —
      // headless probes sample grades without waiting out the transition.
      timeOfDay: (which?: number | string, instant = true) => {
        if (which !== undefined) {
          const idx =
            typeof which === "number"
              ? which % TIME_PHASES.length
              : TIME_PHASES.findIndex((p) => p.name.toLowerCase() === String(which).toLowerCase());
          if (idx >= 0) this.setTimeOfDay(idx, instant);
        }
        return { name: TIME_PHASES[this.timeIdx].name, t: this.timeT, ambient: [...this.curAmbient] };
      },
      // Place/clear a debug light at a grid position (headless probes).
      probeLight: (col?: number, row?: number, z = 0.55, radius = 8) => {
        this.probeLight =
          col === undefined || row === undefined
            ? null
            : { col, row, z, radius, color: [1.5, 1.15, 0.85], flicker: 0 };
        return this.probeLight;
      },
      // Screen-space anchor of a cell's tile image (its 64px art box top-left)
      // + camera zoom — lets probes locate baked-lip rows in screenshots.
      cellScreen: (col: number, row: number) => {
        if (!this.world) return null;
        const { dx, dy, lh } = MAP_GEOMETRY;
        const cam = this.cameras.main;
        const cell = this.world.rows[row]?.[col];
        if (!cell) return null;
        const wx = this.iso.ox + (col - row) * dx;
        const wy = this.iso.oy + (col + row) * dy - cell.l * lh;
        return {
          x: (wx - cam.worldView.x) * cam.zoom,
          y: (wy - cam.worldView.y) * cam.zoom,
          zoom: cam.zoom,
          level: cell.l,
          t: cell.t,
          v: cell.v ?? 0,
        };
      },
      // Draw-order probe: base + lit-copy depths for me and the campfire, so
      // the lit layer's ordering can be asserted numerically (no screenshots).
      litOrder: () => {
        const id = this.room?.sessionId;
        const av = id ? this.avatars.get(id) : undefined;
        return {
          me: av ? { base: av.sprite.depth, lit: av.lit?.visible ? av.lit.depth : null } : null,
          fire: this.campfireSprite
            ? {
                base: this.campfireSprite.depth,
                lit: this.campfireLit?.visible ? this.campfireLit.depth : null,
              }
            : null,
        };
      },
      // Detach the camera and centre it on a cell (headless probes: emissive
      // sites sit far outside walking range on dt-clamped clients). No args
      // re-attaches the camera to the local player.
      lookAt: (col?: number, row?: number) => {
        const cam = this.cameras.main;
        if (col === undefined || row === undefined) {
          const id = this.room?.sessionId;
          const av = id ? this.avatars.get(id) : undefined;
          if (av) cam.startFollow(av.sprite, true, 0.15, 0.15);
          return null;
        }
        cam.stopFollow();
        const { dx, dy, lh } = MAP_GEOMETRY;
        const cell = this.world?.rows[row]?.[col];
        const wx = this.iso.ox + (col - row) * dx + dx;
        const wy = this.iso.oy + (col + row) * dy + dy - (cell?.l ?? 0) * lh;
        cam.centerOn(wx, wy);
        return { x: wx, y: wy, t: cell?.t ?? null, l: cell?.l ?? 0 };
      },
      nightInfo: () => this.night?.debugInfo(),
      // Glow-field RT orientation calibration (headless probes flip + verify).
      glowFlip: (v?: number) => {
        if (this.night && v !== undefined) this.night.glowFlip = v;
        return { flip: this.night?.glowFlip, stamps: this.glowStamps.length };
      },
      nightCal: (flip: number, span: number, test: number) => {
        if (!this.night) return null;
        this.night.fieldFlip = flip;
        this.night.spanScale = span;
        this.night.testPattern = test;
        return { flip, span, test };
      },
    };
  }

  private showConnectionError(err: unknown) {
    const cx = this.scale.width / 2;
    const cy = this.scale.height / 2;
    const panel = this.add.rectangle(cx, cy, Math.min(560, this.scale.width - 40), 150, 0x12121c, 0.92)
      .setScrollFactor(0).setStrokeStyle(2, 0xff6b6b).setDepth(1e9);
    const msg =
      "Can't reach the world server.\n\n" +
      "Is it running?  In dev, run  npm run dev  (starts server + client).\n" +
      "The server should be listening on :2567.";
    this.add.text(cx, cy, msg, {
      color: "#ffd0d0", fontFamily: "system-ui, sans-serif", fontSize: "15px", align: "center",
      wordWrap: { width: panel.width - 30 },
    }).setOrigin(0.5).setScrollFactor(0).setDepth(1e9 + 1);
    console.error("[nangijala] failed to join world:", err);
  }

  private showBubble(id: string, text: string) {
    const av = this.avatars.get(id);
    if (!av) return;
    av.bubble?.destroy();
    const bubble = this.add
      .text(av.sprite.x, av.sprite.y, text, {
        fontFamily: "system-ui, sans-serif",
        fontSize: "13px",
        color: "#12121c",
        backgroundColor: "#f4f4ff",
        padding: { x: 7, y: 4 },
        align: "center",
        wordWrap: { width: 180 },
      })
      .setOrigin(0.5, 1)
      .setDepth(1e9);
    av.bubble = bubble;
    av.bubbleUntil = this.time.now + BUBBLE_MS;
  }

  private refreshRoster() {
    if (!this.room) return;
    const me = this.room.sessionId;
    const players: { name: string; me: boolean }[] = [];
    (this.room.state as any).players.forEach((p: any, id: string) =>
      players.push({ name: p.name || "…", me: id === me }),
    );
    this.roster.refresh(players);
  }

  private addAvatar(id: string, player: any) {
    const uid: string = player.character || this.manifest.characters[0]?.uid || PLACEHOLDER_TEX;
    const key = sheetKey(uid, "idle", DEFAULT_DIRECTION);
    const p0 = this.project(player.x, player.y);
    // Fall back to the built-in wanderer whenever the character's art is absent
    // (empty roster, a deleted character, or art still loading). Tint it per
    // name so same-named wanderers stay distinguishable.
    const hasArt = this.textures.exists(key);
    const sprite = this.add.sprite(p0.x, p0.y, hasArt ? key : PLACEHOLDER_TEX);
    const baseTint = hasArt ? 0xffffff : colorForName(player.name || id);
    sprite.setTint(baseTint);
    // Pin the sprite at the measured foot anchor (sole line) so the drawn feet
    // sit exactly on the collision position; fall back to a sane default.
    this.applyAnchor(sprite, uid, DEFAULT_DIRECTION, hasArt);
    const label = this.add
      .text(p0.x, p0.y, player.name, { fontFamily: "monospace", fontSize: "12px", color: "#eef" })
      .setOrigin(0.5, 1)
      .setDepth(890_000); // names stay readable above occluding tiles
    // Drop shadow at the collision anchor — marks the exact ground position.
    const shadow = this.add.image(p0.x, p0.y, SHADOW_TEX).setOrigin(0.5, 0.5).setDisplaySize(30, 12);
    this.avatars.set(id, {
      sprite,
      shadow,
      label,
      character: uid,
      lx: p0.x,
      ly: p0.y,
      fx: player.x,
      fy: player.y,
      hopUntil: 0,
      swimming: false,
      baseTint,
    });
    this.applyAnimState(this.avatars.get(id)!, player.moving, player.running, player.dir);
  }

  update(_time: number, delta: number) {
    this.redrawGround();
    this.rebuildOccluders();
    if (!this.room) return;
    const dt = delta / 1000;
    const myId = this.room.sessionId;
    this.predictAndSend(dt);

    const state = this.room.state as any;
    if (!state?.players) return; // first frame after join, before the state syncs
    this.avatars.forEach((av, id) => {
      const player = state.players.get(id);
      if (!player) return;

      let tx: number;
      let ty: number;
      let moving: boolean;
      let running: boolean;
      let dir: string;

      if (id === myId) {
        // Reconcile: start from the authoritative position and replay every
        // input the server hasn't acked yet, so the local player is responsive
        // but never drifts from the server.
        this.pending = this.pending.filter((p) => p.seq > player.seq);
        let rx = player.x;
        let ry = player.y;
        const jumping = this.time.now < this.jumpUntil;
        const stepLocal = (ax: number, ay: number, running: boolean, sdt: number) => {
          let blocked;
          let drops;
          let speed = 1;
          if (this.terrain) {
            const ctx = { maxClimb: jumping ? JUMP_CLIMB : WALK_CLIMB, canSwim: true };
            blocked = makeBlocked(this.terrain, ctx);
            drops = makeDrops(this.terrain);
            speed = surfaceAtWorld(this.terrain, rx, ry).speed * (jumping ? JUMP_SPEED_FACTOR : 1);
          }
          // screenInput matches the server: on the iso world, input is screen-relative.
          const r = stepMovement(rx, ry, ax, ay, running, sdt, blocked, speed, !!this.terrain, drops);
          rx = r.x;
          ry = r.y;
        };
        for (const p of this.pending) stepLocal(p.ax, p.ay, p.running, p.dt);
        // Integrate the not-yet-sent input tail too, so the local player moves
        // every FRAME (60fps-smooth) instead of only at the 20Hz send tick.
        if (this.sendAccum > 0)
          stepLocal(this.lastInput.ax, this.lastInput.ay, this.lastInput.running, this.sendAccum);
        tx = rx;
        ty = ry;
        // Animate from live input for instant turn/walk feedback.
        const li = this.lastInput;
        moving = li.ax !== 0 || li.ay !== 0;
        running = li.running && moving;
        dir = (moving ? vectorToDirection(li.ax, li.ay) : null) ?? player.dir;
      } else {
        tx = player.x;
        ty = player.y;
        moving = player.moving;
        running = player.running;
        dir = player.dir;
      }

      // Project the authoritative world position onto the iso ground, then ease
      // the logical position toward it (snappier for the local player).
      av.fx = tx;
      av.fy = ty;
      const target = this.project(tx, ty);
      const k = Math.min(1, dt * (id === myId ? 45 : 12));
      av.lx += (target.x - av.lx) * k;
      av.ly += (target.y - av.ly) * k;

      // Jump hop: a short parabola driven by the synced `jumping` flag.
      if (player.jumping && av.hopUntil <= this.time.now) av.hopUntil = this.time.now + JUMP_MS;
      const hopLeft = av.hopUntil - this.time.now;
      const hop = hopLeft > 0 ? Math.sin((1 - hopLeft / JUMP_MS) * Math.PI) * JUMP_HEIGHT : 0;

      // Swimming: sink slightly and tint blue so it reads as being in water.
      av.swimming = !!player.swimming;
      const sink = av.swimming ? SWIM_SINK : 0;
      av.sprite.setTint(av.swimming ? 0x6fb3ff : av.baseTint);

      av.sprite.x = av.lx;
      av.sprite.y = av.ly - hop + sink;
      // Depth vs occluding columns: a single painter scalar can't resolve
      // every sprite-vs-column case (diagonals, same-level, lower columns),
      // so refine per frame with the EXACT test — a column truly hides the
      // sprite only if its top is strictly higher than the sprite's ground
      // AND it lies on the camera ray (grid interval test). Place the sprite
      // above every falsely-deeper column and below every true occluder.
      const lvl = this.terrain ? levelAtWorld(this.terrain, tx, ty) : 0;
      let depth = av.ly + lvl * MAP_GEOMETRY.lh + 0.5; // unlifted ground y
      if (this.world) {
        const colf = (tx / WORLD_WIDTH) * this.world.width;
        const rowf = (ty / WORLD_HEIGHT) * this.world.height;
        // Sprite bounds = the MEASURED opaque art box (+4px margin for walk
        // frames dipping past the idle anchor). The drawn figure is ~30x68px
        // inside a 128px frame — testing the whole frame let raised cells 2-3
        // tiles away "cover" the sprite via its transparent padding.
        const ab = this.artBounds(av.sprite);
        const aLeft = av.sprite.x - av.sprite.displayWidth * av.sprite.originX;
        const aTop = av.sprite.y - av.sprite.displayHeight * av.sprite.originY;
        const sx0 = aLeft + ab.x0 * av.sprite.scaleX - 4;
        const sx1 = aLeft + ab.x1 * av.sprite.scaleX + 4;
        const sy0 = aTop + ab.y0 * av.sprite.scaleY - 4;
        const sy1 = aTop + ab.y1 * av.sprite.scaleY + 4;
        let above = -Infinity;
        let below = Infinity;
        let coverY = Infinity;
        const feetY = av.ly;
        for (const o of this.occluderMeta) {
          if (o.x1 < sx0 || o.x0 > sx1 || o.y1 < sy0 || o.y0 > sy1) continue;
          const higher = o.top > lvl;
          // (a) Wall genuinely between the camera and the feet point.
          const t0 = Math.max(o.col - colf, o.row - rowf);
          const t1 = Math.min(o.col + 1 - colf, o.row + 1 - rowf);
          const rayBlocked = higher && t1 > Math.max(t0, 0);
          // (b) A higher column whose LIFTED TOP FACE overlaps the feet band
          // (the sprite is a billboard — raised corners of side/front
          // neighbours pass in front of its lower pixels even when the feet
          // point itself is visible) and whose face is camera-closer.
          const faceOverFeet =
            higher &&
            o.y0 <= feetY + 6 &&
            o.y0 >= feetY - 26 &&
            o.col + o.row + 1.2 > colf + rowf;
          if (rayBlocked || faceOverFeet) {
            below = Math.min(below, o.depth);
            coverY = Math.min(coverY, o.y0);
          } else above = Math.max(above, o.depth);
        }
        if (above > -Infinity) depth = Math.max(depth, above + 0.6);
        if (below < Infinity) depth = Math.min(depth, below - 0.3); // walls win conflicts
        av.coverY = below < Infinity ? coverY : undefined;
      } else {
        av.coverY = undefined;
      }
      av.sprite.setDepth(depth);
      // Shadow: always at the GROUND point (the collision anchor) — it stays
      // put while the sprite hops, shrinking a little at the jump's peak.
      const hopFrac = hop / JUMP_HEIGHT;
      av.shadow
        .setPosition(av.lx, av.ly)
        .setVisible(!av.swimming)
        .setAlpha(1 - hopFrac * 0.35)
        .setDisplaySize(34 - hopFrac * 9, 14 - hopFrac * 4)
        .setDepth(av.sprite.depth - 0.1);
      // Head top (measured from the art), not the frame top — labels hug the
      // character instead of floating over transparent padding.
      const topFrac = (av.sprite.getData("topFrac") as number) ?? 0;
      const topY = av.sprite.y - av.sprite.displayHeight * (av.sprite.originY - topFrac);
      av.label.setPosition(av.lx, topY - 4);
      if (av.bubble) {
        av.bubble.setPosition(av.lx, topY - 18);
        if (this.time.now > (av.bubbleUntil ?? 0)) {
          av.bubble.destroy();
          av.bubble = undefined;
        }
      }
      this.applyAnimState(av, moving, running, dir);
    });

    // Local player's swim-stamina HUD.
    const me = state.players.get(myId);
    if (me) this.drawStaminaBar(me.stamina ?? MAX_STAMINA, !!me.swimming);

    // Night lighting (always on): per-pixel point lights with heightmap
    // line-of-sight when WebGL is available; the multiply grade otherwise.
    const shaderNight = !!this.night;
    this.night?.setActive(shaderNight);
    this.atmo.suppressGrade = shaderNight;
    if (shaderNight && this.world) {
      const sl: ShaderLight[] = [];
      // Debug-only probe light (set via __ml.probeLight) — lets headless
      // verification place a light at an exact grid position, since walking
      // there is dt-clamped to a crawl on slow headless clients.
      if (this.probeLight) sl.push(this.probeLight);
      if (this.campfire) {
        const c = this.campfire;
        // Overbright core: the shader clamps the multiplier at 1.25, so values
        // >1 widen the hot plateau around the fire (ref: bright ~2 cells, then
        // a fast falloff into the ember-red rim).
        sl.push({ col: c.col, row: c.row, z: c.z, radius: 7, color: [1.9, 0.88, 0.3], flicker: 1 });
      }
      // Torches fill up to the cap MINUS a few slots reserved for emission
      // glow pools — a crowded camp must not un-light the lava beside it.
      const reserve = Math.min(3, this.shaderLights.length);
      for (const [id, a] of this.avatars.entries()) {
        if (id === myId && !this.torchOn) continue;
        if (sl.length >= MAX_SHADER_LIGHTS - reserve) break;
        // Grid position from the FLAT authoritative coords (1 cell = CELL_WU
        // world units) — the projected lx/ly live in screen space and put the
        // torch underground, so the terrain shadowed its own light.
        sl.push({
          col: a.fx / CELL_WU,
          row: a.fy / CELL_WU,
          // Held low (waist height): a high torch grazes over ledge lips and
          // lights ground far below cliffs, which reads as leakage.
          z: (this.terrain ? levelAtWorld(this.terrain, a.fx, a.fy) : 0) + 0.55,
          radius: 6,
          color: [0.85, 0.58, 0.32],
          flicker: 0.35, // hand torch: gentle fire flicker
        });
      }
      for (const l of this.shaderLights) {
        if (sl.length >= MAX_SHADER_LIGHTS) break;
        sl.push(l);
      }
      // Time-of-day: ease the on-screen grade toward the target phase.
      // Wall-clock driven — the physics dt is clamped per frame and would
      // crawl on slow clients. Night's values are the calibrated reference.
      if (this.timeT < 1)
        this.timeT = Math.min(1, (this.time.now - this.timeStart) / (TIME_TRANSITION_S * 1000));
      const e = this.timeT * this.timeT * (3 - 2 * this.timeT); // smoothstep
      const target = TIME_PHASES[this.timeIdx];
      for (let ch = 0; ch < 3; ch++)
        this.curAmbient[ch] = this.timeFromAmbient[ch] + (target.ambient[ch] - this.timeFromAmbient[ch]) * e;
      this.night!.update(this.cameras.main, sl, this.curAmbient, this.glowStamps);
    }

    const lights: LightSource[] = [];
    if (this.campfire) {
      const c = this.campfire;
      // Additive bloom hugging the flames (both render paths) — the shader
      // lights the WORLD but the fire itself must also glow, like the ref.
      // Slow breathing, not a strobe: ~4s and ~1.4s periods, small swing.
      const flick = 0.52 + Math.sin(this.time.now / 640) * 0.05 + Math.sin(this.time.now / 225) * 0.03;
      lights.push({ x: c.x, y: c.y - 9, color: 0xff8830, radius: 72, alpha: flick, depth: c.depth + 0.2 });
      // Flame-core bloom ABOVE the night grade + vignette so the flame never
      // goes dull at screen edges — but sized to HUG the flame (a big fixed
      // disc read as a floating ball from afar) and scaled by proximity, so
      // the fire joins the brightens-as-you-approach effect.
      const camMid = this.cameras.main.midPoint;
      const camDist = Math.hypot(c.x - camMid.x, c.y - camMid.y);
      const near = Math.max(0.45, Math.min(1, 1.15 - camDist / 1400));
      lights.push({ x: c.x, y: c.y - 12, color: 0xffb75a, radius: 12, alpha: (flick + 0.2) * near, depth: 900_005 });
      if (!shaderNight)
        lights.push({ x: c.x, y: c.y, color: 0xff9e4a, radius: 120, ground: true, depth: c.depth + 0.1 });
    }
    if (!shaderNight) {
      for (const [id, a] of this.avatars.entries()) {
        if (id === myId && !this.torchOn) continue;
        lights.push({ x: a.lx, y: a.ly - 20 }); // lantern pool
      }
      lights.push(...this.emissiveLights);
    }
    this.applyObjectLights();
    this.atmo.update(lights, this.cameras.main, dt);
  }

  /** Start easing toward a time-of-day phase FROM the grade currently on
   * screen — pressing [1] mid-transition retargets without a jump. */
  private setTimeOfDay(idx: number, instant = false) {
    this.timeFromAmbient = [...this.curAmbient];
    this.timeIdx = idx;
    this.timeT = instant ? 1 : 0;
    this.timeStart = this.time.now;
    if (instant) this.curAmbient = [...TIME_PHASES[idx].ambient];
  }

  /** Lit copies: a pixel-identical duplicate of each character drawn ABOVE
   * the darkness overlay, tinted by its ground-cell light — exact silhouette
   * with zero shader plumbing. When a wall draws over the sprite the copy is
   * CROPPED below the wall's top line (not hidden): the covered part defers
   * to the depth-sorted under-sprite, everything above it stays lit. */
  private applyObjectLights() {
    const night = this.night;
    const on = !!night && night.active;
    for (const a of this.avatars.values()) {
      if (!a.lit) {
        a.lit = this.add.sprite(a.sprite.x, a.sprite.y, a.sprite.texture.key).setDepth(900_001);
      }
      if (!on || !a.sprite.visible) {
        a.lit.setVisible(false);
        continue;
      }
      const lvl = this.terrain ? levelAtWorld(this.terrain, a.fx, a.fy) : 0;
      const l = night!.lightAt(a.fx / CELL_WU, a.fy / CELL_WU, lvl, false);
      const base = a.swimming ? 0x6fb3ff : a.baseTint;
      const r = Math.min(255, Math.round(((base >> 16) & 0xff) * Math.min(1, l[0])));
      const g = Math.min(255, Math.round(((base >> 8) & 0xff) * Math.min(1, l[1])));
      const bl = Math.min(255, Math.round((base & 0xff) * Math.min(1, l[2])));
      a.lit
        .setVisible(true)
        .setTexture(a.sprite.texture.key, a.sprite.frame.name)
        .setPosition(a.sprite.x, a.sprite.y)
        .setOrigin(a.sprite.originX, a.sprite.originY)
        .setScale(a.sprite.scaleX, a.sprite.scaleY)
        .setDepth(litDepth(a.sprite.depth))
        .setTint((r << 16) | (g << 8) | bl);
      if (a.coverY !== undefined) {
        // Frame-space y of the occluding wall's top line.
        const frameTop = a.sprite.y - a.sprite.displayHeight * a.sprite.originY;
        const cropH = (a.coverY - frameTop) / a.sprite.scaleY;
        const ab = this.artBounds(a.sprite);
        if (cropH <= ab.y0 + 2) a.lit.setVisible(false); // wall covers the whole figure
        else a.lit.setCrop(0, 0, a.sprite.frame.cutWidth, cropH);
      } else if (a.lit.isCropped) a.lit.setCrop();
    }
    if (this.campfireSprite) {
      if (!this.campfireLit) {
        this.campfireLit = this.add
          .sprite(this.campfireSprite.x, this.campfireSprite.y, CAMPFIRE_KEY)
          .setOrigin(0.5, CAMPFIRE_BASE)
          .setScale(CAMPFIRE_SCALE);
      }
      this.campfireLit
        .setVisible(on)
        .setFrame(this.campfireSprite.frame.name)
        .setPosition(this.campfireSprite.x, this.campfireSprite.y)
        .setDepth(litDepth(this.campfireSprite.depth));
    }
  }

  private predictAndSend(dt: number) {
    const k = this.keys;
    const ax = (down(k.D) || down(k.RIGHT) ? 1 : 0) - (down(k.A) || down(k.LEFT) ? 1 : 0);
    const ay = (down(k.S) || down(k.DOWN) ? 1 : 0) - (down(k.W) || down(k.UP) ? 1 : 0);
    const running = down(k.SHIFT);
    const sig = `${ax},${ay},${running ? 1 : 0}`;
    // If the input CHANGED, flush the elapsed window under the PREVIOUS input
    // first. Otherwise a quick tap gets re-attributed to the new vector (e.g.
    // idle) — the tap's movement evaporates and the player pops back.
    if (sig !== this.lastSent && this.sendAccum > 0) this.flushInput();
    this.lastInput = { ax, ay, running };
    this.lastSent = sig;
    this.sendAccum += dt;
    // Regular cadence, and jumps flush immediately so the edge isn't delayed.
    if (this.jumpQueued || this.sendAccum >= 1 / INPUT_HZ) this.flushInput();
  }

  /** Persist + send the accumulated input window (prediction and server get
   * the exact same vector and duration). */
  private flushInput() {
    const li = this.lastInput;
    this.inputSeq += 1;
    this.pending.push({ seq: this.inputSeq, ax: li.ax, ay: li.ay, running: li.running, dt: this.sendAccum });
    const msg: InputMessage = { ax: li.ax, ay: li.ay, running: li.running, seq: this.inputSeq, dt: this.sendAccum };
    if (this.jumpQueued) {
      msg.jump = true;
      this.jumpQueued = false;
    }
    this.room!.send("input", msg);
    this.sendAccum = 0;
  }

  private applyAnimState(av: Avatar, moving: boolean, running: boolean, dir: string) {
    const state = moving ? (running ? "run" : "walk") : "idle";
    const d = DIRECTIONS.includes(dir as never) ? dir : DEFAULT_DIRECTION;
    const key = this.resolveAnim(av.character, state, d);
    if (key && av.sprite.anims.getName() !== key) {
      av.sprite.play(key, true);
      // The foot position shifts slightly between directions — re-pin.
      this.applyAnchor(av.sprite, av.character, d, av.sprite.texture.key !== PLACEHOLDER_TEX);
    }
  }

  /** Opaque art bounds inside the sprite's current frame (frame px), measured
   * once per texture+frame from the alpha channel and cached. The drawn figure
   * occupies a small box in the middle of a mostly-transparent frame; occlusion
   * tests against the full frame hit walls tiles away from the body. */
  private artBoundsCache = new Map<string, { x0: number; y0: number; x1: number; y1: number }>();

  private artBounds(sprite: Phaser.GameObjects.Sprite) {
    const frame = sprite.frame;
    const key = `${frame.texture.key}#${frame.name}`;
    let b = this.artBoundsCache.get(key);
    if (b) return b;
    b = { x0: 0, y0: 0, x1: frame.cutWidth, y1: frame.cutHeight }; // fallback: whole frame
    try {
      const src = frame.source.image as CanvasImageSource;
      const cnv = document.createElement("canvas");
      cnv.width = frame.cutWidth;
      cnv.height = frame.cutHeight;
      const ctx = cnv.getContext("2d", { willReadFrequently: true });
      if (src && ctx) {
        ctx.drawImage(src, frame.cutX, frame.cutY, frame.cutWidth, frame.cutHeight, 0, 0, cnv.width, cnv.height);
        const d = ctx.getImageData(0, 0, cnv.width, cnv.height).data;
        let x0 = cnv.width, y0 = cnv.height, x1 = -1, y1 = -1;
        for (let y = 0; y < cnv.height; y++)
          for (let x = 0; x < cnv.width; x++)
            if (d[(y * cnv.width + x) * 4 + 3] > 16) {
              if (x < x0) x0 = x;
              if (x > x1) x1 = x;
              if (y < y0) y0 = y;
              if (y > y1) y1 = y;
            }
        if (x1 >= x0) b = { x0, y0, x1: x1 + 1, y1: y1 + 1 };
      }
    } catch {
      // Unreadable source (shouldn't happen same-origin) — keep the fallback.
    }
    this.artBoundsCache.set(key, b);
    return b;
  }

  /** Set the sprite origin to the measured foot anchor for this direction and
   * remember the head-top fraction for label placement. */
  private applyAnchor(sprite: Phaser.GameObjects.Sprite, uid: string, dir: string, hasArt: boolean) {
    if (!hasArt) {
      sprite.setOrigin(0.5, 0.94); // placeholder wanderer: feet at 32/34
      sprite.setData("topFrac", 0.1);
      return;
    }
    const def = this.manifest.characters.find((c) => c.uid === uid);
    const a = def?.anchors?.[dir] ?? def?.anchors?.[DEFAULT_DIRECTION];
    if (a) {
      sprite.setOrigin(a.x, a.y);
      sprite.setData("topFrac", a.top ?? Math.max(0, a.y - 0.55));
    } else {
      sprite.setOrigin(0.5, 0.9);
      sprite.setData("topFrac", 0.25);
    }
  }

  /** Pick an existing animation, falling back run→walk→idle then default dir. */
  private resolveAnim(uid: string, state: string, dir: string): string | null {
    const order = state === "run" ? ["run", "walk", "idle"] : state === "walk" ? ["walk", "idle"] : ["idle"];
    for (const s of order) {
      for (const d of [dir, DEFAULT_DIRECTION]) {
        const key = animKey(uid, s, d);
        if (this.anims.exists(key)) return key;
      }
    }
    return null;
  }

  private buildAnimations() {
    for (const def of this.manifest.characters) {
      for (const [anim, dirs] of Object.entries(def.animations)) {
        for (const dir of Object.keys(dirs)) {
          const sheet = sheetKey(def.uid, anim, dir);
          const key = animKey(def.uid, anim, dir);
          if (!this.textures.exists(sheet) || this.anims.exists(key)) continue;
          this.anims.create({
            key,
            frames: this.anims.generateFrameNumbers(sheet, {}),
            frameRate: ANIM_FPS[anim] ?? 10,
            repeat: -1,
          });
        }
      }
    }
  }

  /**
   * Streaming ground: the world is far too large to bake into one texture
   * (512×448 cells ≈ 30k px wide). Instead a world-anchored RenderTexture
   * covering the screen plus GROUND_MARGIN on every side is redrawn only when
   * the camera wanders near its edge — scrolling between redraws costs nothing.
   * Painter order comes free from iterating v = col+row back-to-front.
   */
  private setupStreamingGround() {
    const world = this.world!;
    const cs = canvasSize(world);
    this.iso = { ox: cs.ox, oy: cs.oy, w: cs.w, h: cs.h };
    this.maxLevel = cs.maxLevel;
    this.makeGroundRT();
    this.scale.on("resize", () => this.makeGroundRT());
  }

  private makeGroundRT() {
    this.groundRT?.destroy();
    this.groundRT = this.add
      .renderTexture(0, 0, this.scale.width + GROUND_MARGIN * 2, this.scale.height + GROUND_MARGIN * 2)
      .setOrigin(0, 0)
      .setDepth(-1_000_000);
    this.lastGround = { x: NaN, y: NaN };
  }

  private redrawGround() {
    if (!this.world || !this.groundRT) return;
    const cam = this.cameras.main;
    const ccx = cam.scrollX + cam.width / 2;
    const ccy = cam.scrollY + cam.height / 2;
    // Only redraw when the camera centre strays GROUND_MARGIN/2 from the last
    // anchor — everything in between scrolls the already-drawn texture.
    if (
      !Number.isNaN(this.lastGround.x) &&
      Math.abs(ccx - this.lastGround.x) < GROUND_MARGIN / 2 &&
      Math.abs(ccy - this.lastGround.y) < GROUND_MARGIN / 2
    )
      return;
    this.lastGround = { x: ccx, y: ccy };

    const world = this.world;
    const { dx, dy, lh, tile } = MAP_GEOMETRY;
    const rt = this.groundRT;
    // Anchor the texture in world space around the camera centre.
    const ax = Math.round(ccx - rt.width / 2);
    const ay = Math.round(ccy - rt.height / 2);
    rt.setPosition(ax, ay);
    rt.clear();
    rt.fill(0x181c28, 1);

    // Covered rect in virtual-canvas coords, padded for tile size + max lift.
    const x0 = ax - tile;
    const x1 = ax + rt.width + tile;
    const y0 = ay - tile;
    const y1 = ay + rt.height + tile + this.maxLevel * lh;
    // u = col−row indexes screen-x; v = col+row indexes screen-y.
    const u0 = Math.floor((x0 - this.iso.ox) / dx) - 1;
    const u1 = Math.ceil((x1 - this.iso.ox) / dx) + 1;
    const v0 = Math.max(0, Math.floor((y0 - this.iso.oy) / dy) - 1);
    const v1 = Math.ceil((y1 - this.iso.oy) / dy) + 1;

    rt.beginDraw();
    for (let v = v0; v <= v1; v++) {
      for (let u = u0; u <= u1; u++) {
        if ((u + v) & 1) continue; // col/row must be integers
        const col = (u + v) / 2;
        const row = (v - u) / 2;
        if (col < 0 || row < 0 || col >= world.width || row >= world.height) continue;
        const cell = world.rows[row][col];
        const key = tileKey(cell.t, cell.v);
        if (!this.textures.exists(key)) continue;
        const bx = this.iso.ox + u * dx - ax;
        const by = this.iso.oy + v * dy - ay;
        for (let lvl = 0; lvl <= cell.l; lvl++) rt.batchDraw(key, bx, by - lvl * lh);
        // Baked contact shadows from higher sun-side neighbours: a DAYLIGHT
        // elevation cue. Under the per-pixel night shader they double-darken
        // every ledge with hard-edged black gradients the light multiplies
        // UNDER — the razor-sharp black edges no field softening can remove.
        // The shader's own occlusion/face lighting carries the depth cue now.
        if (!this.night) {
          const own = cell.l;
          const topY = by - cell.l * lh;
          const dW = Math.min(3, this.effHeight(col - 1, row, own) - own);
          const dN = Math.min(3, this.effHeight(col, row - 1, own) - own);
          const dNW = Math.min(3, this.effHeight(col - 1, row - 1, own) - own);
          if (dW > 0) rt.batchDraw("shade-w", bx, topY, 0.22 + dW * 0.14);
          if (dN > 0) rt.batchDraw("shade-n", bx, topY, 0.18 + dN * 0.12);
          if (dNW > 0 && dW <= 0 && dN <= 0) rt.batchDraw("shade-nw", bx, topY, 0.3);
        }
      }
    }
    rt.endDraw();
  }

  /** Start a jump if grounded and off cooldown (client-side prediction; the
   * server independently validates from the jump input). */
  private tryJump() {
    const now = this.time.now;
    if (now < this.jumpUntil || now < this.jumpReadyAt) return;
    this.jumpUntil = now + JUMP_MS;
    this.jumpReadyAt = now + JUMP_MS + JUMP_COOLDOWN_MS;
    this.jumpQueued = true;
  }

  /** Toggle a debug overlay marking non-standable cells around the camera
   * (blue = swimmable water, red = solid). Redrawn for the CURRENT view each
   * time it's toggled on — the world is far too large to mark everywhere. */
  private toggleCollisionOverlay() {
    if (this.collisionOverlay) {
      this.collisionOverlay.destroy();
      this.collisionOverlay = undefined;
      return;
    }
    if (!this.world) return;
    const { dx, dy, lh } = MAP_GEOMETRY;
    const cam = this.cameras.main;
    const g = this.add.graphics().setDepth(1_000_000);
    const u0 = Math.floor((cam.worldView.x - this.iso.ox) / dx) - 2;
    const u1 = Math.ceil((cam.worldView.right - this.iso.ox) / dx) + 2;
    const v0 = Math.max(0, Math.floor((cam.worldView.y - this.iso.oy) / dy) - 2);
    const v1 = Math.ceil((cam.worldView.bottom - this.iso.oy + this.maxLevel * lh) / dy) + 2;
    for (let v = v0; v <= v1; v++) {
      for (let u = u0; u <= u1; u++) {
        if ((u + v) & 1) continue;
        const col = (u + v) / 2;
        const row = (v - u) / 2;
        const cell = this.world.rows[row]?.[col];
        if (!cell) continue;
        const s = surfaceFor(cell.t);
        if (s.standable) continue;
        // Water reads soft blue; solid blockers pop in strong red.
        if (s.swimmable) g.fillStyle(0x3bb0ff, 0.3);
        else g.fillStyle(0xff0000, 0.55);
        const bx = this.iso.ox + u * dx;
        const by = this.iso.oy + v * dy - cell.l * lh;
        g.fillPoints(
          [
            new Phaser.Geom.Point(bx + dx, by),
            new Phaser.Geom.Point(bx + dx * 2, by + dy),
            new Phaser.Geom.Point(bx + dx, by + dy * 2),
            new Phaser.Geom.Point(bx, by + dy),
          ],
          true,
        );
      }
    }
    this.collisionOverlay = g;
  }

  /** Draw the local player's swim-stamina bar (bottom-centre HUD), shown only
   * while swimming or recovering. */
  private drawStaminaBar(stamina: number, swimming: boolean) {
    if (!this.staminaBar) this.staminaBar = this.add.graphics().setScrollFactor(0).setDepth(2_000_000);
    const g = this.staminaBar;
    g.clear();
    const frac = Math.max(0, Math.min(1, stamina / MAX_STAMINA));
    if (!swimming && frac >= 1) return; // hide when full and on land
    const w = 220;
    const h = 12;
    const x = this.scale.width / 2 - w / 2;
    const y = this.scale.height - 34;
    g.fillStyle(0x0d0d18, 0.75).fillRoundedRect(x - 3, y - 3, w + 6, h + 6, 5);
    g.fillStyle(0x2a2f45, 1).fillRoundedRect(x, y, w, h, 4);
    const col = frac > 0.5 ? 0x57c7ff : frac > 0.25 ? 0xffcf4a : 0xff5a5a;
    g.fillStyle(col, 1).fillRoundedRect(x, y, w * frac, h, 4);
  }

  /**
   * Rebuild the occluder set: every raised (l>0) or solid non-water tile near
   * the camera gets real depth-sorted images (depth = its footprint's TOP
   * vertex y), so sprites standing behind it are covered while sprites in
   * front draw over it. The ground RT stays as the flat base underneath.
   */
  private rebuildOccluders() {
    if (!this.world) return;
    const cam = this.cameras.main;
    const ccx = cam.worldView.centerX;
    const ccy = cam.worldView.centerY;
    if (
      !Number.isNaN(this.lastOccl.x) &&
      Math.abs(ccx - this.lastOccl.x) < 96 &&
      Math.abs(ccy - this.lastOccl.y) < 96
    )
      return;
    this.lastOccl = { x: ccx, y: ccy };
    for (const im of this.occluders) im.destroy();
    this.occluders = [];
    this.occluderMeta = [];
    this.emissiveLights = [];
    this.shaderLights = [];

    const { dx, dy, lh, tile: tileSize } = MAP_GEOMETRY;
    // Emission pool clustering: one glow light per bucket of nearby glowing
    // cells of the same category (a lava lake = a few soft pools).
    const buckets = new Map<
      string,
      { color: [number, number, number]; strength: number; radius: number; flicker: number; n: number; sc: number; sr: number; z: number }
    >();
    const pad = 200;
    const x0 = cam.worldView.x - pad;
    const x1 = cam.worldView.right + pad;
    const y0 = cam.worldView.y - pad;
    const y1 = cam.worldView.bottom + pad + this.maxLevel * lh;
    const u0 = Math.floor((x0 - this.iso.ox) / dx) - 1;
    const u1 = Math.ceil((x1 - this.iso.ox) / dx) + 1;
    const v0 = Math.max(0, Math.floor((y0 - this.iso.oy) / dy) - 1);
    const v1 = Math.ceil((y1 - this.iso.oy) / dy) + 1;
    for (let v = v0; v <= v1; v++) {
      for (let u = u0; u <= u1; u++) {
        if ((u + v) & 1) continue;
        const col = (u + v) / 2;
        const row = (v - u) / 2;
        const cell = this.world.rows[row]?.[col];
        if (!cell) continue;
        const s = surfaceFor(cell.t);
        // Emissive tiles (tiles/emission.json): atmosphere bloom for the
        // canvas fallback + a cluster-bucket sample for the shader pools.
        // Per-VARIANT: plain variants of a glowing category stay dark (only
        // variants with detected glow sources emit; v1 entries emit always).
        const em = this.emission[cell.t];
        const variantGlows = em && (!em.sources || (em.sources[String(cell.v)]?.length ?? 0) > 0);
        if (em && variantGlows) {
          if (!this.night && this.emissiveLights.length < MAX_EMISSIVE) {
            const hex =
              (Math.round(em.color[0] * 255) << 16) |
              (Math.round(em.color[1] * 255) << 8) |
              Math.round(em.color[2] * 255);
            this.emissiveLights.push({
              x: this.iso.ox + u * dx + dx,
              y: this.iso.oy + v * dy + dy - cell.l * lh,
              color: hex,
              radius: em.radius * 32,
              ground: true,
              depth: this.iso.oy + v * dy + dy + 0.2, // occluded by fronting walls
            });
          }
          const sample = (kind: string, sc: number, sr: number, sz: number) => {
            const bk = `${cell.t}:${kind}:${Math.floor(col / EMISSION_BUCKET)}:${Math.floor(row / EMISSION_BUCKET)}`;
            let b = buckets.get(bk);
            if (!b) {
              b = {
                color: em.color,
                strength: em.strength,
                radius: em.radius,
                flicker: em.anim === "flicker" ? 0.6 : 0,
                n: 0,
                sc: 0,
                sr: 0,
                z: 0,
              };
              buckets.set(bk, b);
            }
            b.n++;
            b.sc += sc;
            b.sr += sr;
            b.z += sz;
          };
          // Top glow pool: lights the surface around the tile.
          sample("t", col + 0.5, row + 0.5, cell.l + 0.6);
          // Exposed SIDE FACES are area lights of their own: a pool floating
          // in FRONT of the face at mid-face height. The top pool can't do
          // this job — for a tall column it sits levels above the ground at
          // the base (the vertical falloff eats it), and it stands BEHIND
          // the neighbouring wall's plane so the Lambert gate zeroes it —
          // the playtester's "glowing wall next to a pitch-dark one" seam.
          const lS = this.world.rows[row + 1]?.[col]?.l;
          const lE = this.world.rows[row]?.[col + 1]?.l;
          if (lS !== undefined && cell.l - lS >= 1)
            sample("s", col + 0.5, row + 1.35, (cell.l + lS) / 2 + 0.3);
          if (lE !== undefined && cell.l - lE >= 1)
            sample("e", col + 1.35, row + 0.5, (cell.l + lE) / 2 + 0.3);
        }
        const tall = cell.l > 0 || (!s.standable && !s.swimmable);
        if (!tall) continue;
        const key = tileKey(cell.t, cell.v);
        if (!this.textures.exists(key)) continue;
        const bx = this.iso.ox + u * dx;
        const by = this.iso.oy + v * dy;
        // Depth = the column's CENTRE line (by + dy); avatars refine their own
        // depth against these per frame (see update) since a single scalar
        // can't resolve every sprite-vs-column case exactly.
        for (let lvl = 0; lvl <= cell.l; lvl++) {
          this.occluders.push(this.add.image(bx, by - lvl * lh, key).setOrigin(0, 0).setDepth(by + dy));
        }
        this.occluderMeta.push({
          col,
          row,
          // Solid structures (trees, boulders…) visually stand ~1 level tall.
          top: cell.l + (s.standable ? 0 : 1),
          depth: by + dy,
          x0: bx,
          x1: bx + tileSize,
          y0: by - cell.l * lh,
          y1: by + tileSize,
        });
        // Match the ground pass's contact shadows on redrawn column tops —
        // daylight/canvas fallback only (see drawGroundWindow).
        if (!this.night) {
          const own = cell.l;
          const topY = by - cell.l * lh;
          const dW = Math.min(3, this.effHeight(col - 1, row, own) - own);
          const dN = Math.min(3, this.effHeight(col, row - 1, own) - own);
          if (dW > 0)
            this.occluders.push(
              this.add.image(bx, topY, "shade-w").setOrigin(0, 0).setAlpha(0.22 + dW * 0.14).setDepth(by + dy + 0.05),
            );
          if (dN > 0)
            this.occluders.push(
              this.add.image(bx, topY, "shade-n").setOrigin(0, 0).setAlpha(0.18 + dN * 0.12).setDepth(by + dy + 0.05),
            );
        }
      }
    }

    // Shader glow pools: nearest clusters win the limited light slots. Pool
    // radius grows gently with cluster size (a lake glows wider than a vein);
    // NEGATIVE radius marks them shadow-free in the shader. Ember-rim flicker
    // only for fire-like anims — a pulsing crystal must not turn red at its
    // rim (the pulse itself lives in the per-pixel self floor).
    if (buckets.size) {
      const uC = (ccx - this.iso.ox) / dx;
      const vC = (ccy - this.iso.oy) / dy;
      const cCol = (uC + vC) / 2;
      const cRow = (vC - uC) / 2;
      const pools = [...buckets.values()]
        .map((b) => ({ b, col: b.sc / b.n, row: b.sr / b.n }))
        .sort(
          (a, z) =>
            (a.col - cCol) ** 2 + (a.row - cRow) ** 2 - ((z.col - cCol) ** 2 + (z.row - cRow) ** 2),
        )
        .slice(0, EMISSION_POOL_MAX);
      for (const { b, col, row } of pools) {
        this.shaderLights.push({
          col,
          row,
          z: b.z / b.n, // mean sample height (tops carry their own +0.6)
          radius: -(b.radius * (1 + 0.35 * Math.sqrt(b.n - 1))),
          color: [b.color[0] * b.strength, b.color[1] * b.strength, b.color[2] * b.strength],
          flicker: b.flicker,
        });
      }
    }

    // Per-pixel glow halos (tile-emission@2 sources) for this window.
    this.glowStamps = buildGlowStamps(
      this.world,
      this.emission,
      this.iso,
      { x0, y0, x1, y1 },
      this.maxLevel,
    );
  }

  /** A burning campfire beside the spawn point — the gathering spot. The
   * server spawns newcomers around findSpawn(world centre), which is a pure
   * function of the terrain, so the client can find the same cell and dress
   * it without any server round-trip. Its fire feeds the night shader. */
  private placeCampfire() {
    if (!this.world || !this.terrain) return;
    if (!this.textures.exists(CAMPFIRE_KEY)) {
      // Never fail silently: a missing strip (e.g. asset domain absent from
      // the deploy image) must be visible in the console, not just "no fire".
      console.warn(`[nangijala] campfire strip missing (${CAMPFIRE_URL}) — fire not placed`);
      return;
    }
    const spawn = findSpawn(this.terrain, WORLD_WIDTH / 2, WORLD_HEIGHT / 2);
    const sc = Math.floor(spawn.x / CELL_WU);
    const sr = Math.floor(spawn.y / CELL_WU);
    const sLvl = levelAtWorld(this.terrain, spawn.x, spawn.y);
    // A couple of cells away from the exact spawn cell so players don't pop
    // into existence standing in the flames. First standable same-level
    // neighbour in a fixed order keeps it deterministic for everyone.
    let cell = { col: sc, row: sr };
    for (const [dc, dr] of [[2, 0], [0, 2], [2, 2], [-2, 0], [0, -2], [-2, -2], [1, 1], [0, 0]]) {
      const cx = (sc + dc + 0.5) * CELL_WU;
      const cy = (sr + dr + 0.5) * CELL_WU;
      if (isStandableAtWorld(this.terrain, cx, cy) && levelAtWorld(this.terrain, cx, cy) === sLvl) {
        cell = { col: sc + dc, row: sr + dr };
        break;
      }
    }
    const fx = (cell.col + 0.5) * CELL_WU;
    const fy = (cell.row + 0.5) * CELL_WU;
    const lvl = levelAtWorld(this.terrain, fx, fy);
    const p = this.project(fx, fy);
    // Same depth formula as players (unlifted ground y), nudged behind a
    // player standing on the very same cell.
    const depth = p.y + lvl * MAP_GEOMETRY.lh + 0.4;
    if (!this.anims.exists(CAMPFIRE_KEY)) {
      this.anims.create({
        key: CAMPFIRE_KEY,
        frames: this.anims.generateFrameNumbers(CAMPFIRE_KEY, { start: 0, end: CAMPFIRE_FRAMES - 1 }),
        frameRate: 12,
        repeat: -1,
      });
    }
    this.campfireSprite = this.add
      .sprite(p.x, p.y, CAMPFIRE_KEY)
      .setOrigin(0.5, CAMPFIRE_BASE)
      .setScale(CAMPFIRE_SCALE)
      .setDepth(depth)
      .play(CAMPFIRE_KEY);
    // Light at flame height: full fire flicker for the shader; a warm glow
    // for the canvas fallback (drawn in update()).
    this.campfire = { col: cell.col + 0.5, row: cell.row + 0.5, z: lvl + 0.5, x: p.x, y: p.y - 4, depth };
  }

  /** Project an authoritative world position (flat x,y) onto the iso ground —
   * the point where a character's feet stand, lifted by that cell's elevation. */
  private project(px: number, py: number): { x: number; y: number } {
    if (!this.world) return { x: px, y: py };
    const { dx, dy, lh, tile } = MAP_GEOMETRY;
    const W = this.world.width;
    const H = this.world.height;
    const col = Math.max(0, Math.min(W - 0.001, (px / WORLD_WIDTH) * W));
    const row = Math.max(0, Math.min(H - 0.001, (py / WORLD_HEIGHT) * H));
    const lvl = this.world.rows[Math.floor(row)]?.[Math.floor(col)]?.l ?? 0;
    return {
      x: this.iso.ox + (col - row) * dx + tile / 2,
      y: this.iso.oy + (col + row) * dy + dy - lvl * lh,
    };
  }

  /**
   * Contact-shadow overlays for elevation readability: a tile with HIGHER
   * ground on its sun-side (screen-left → grid west/north) gets a soft dark
   * gradient along that edge, scaled by the height difference. Baked into the
   * ground pass — the classic "just works" iso AO trick.
   */
  private ensureShadeTextures() {
    const { dy, tile } = MAP_GEOMETRY;
    const w = tile;
    const h = dy * 2;
    const make = (key: string, draw: (ctx: CanvasRenderingContext2D) => void) => {
      if (this.textures.exists(key)) return;
      const tex = this.textures.createCanvas(key, w, h);
      const ctx = tex!.getContext();
      // Clip to the tile's top diamond.
      ctx.beginPath();
      ctx.moveTo(w / 2, 0);
      ctx.lineTo(w, h / 2);
      ctx.lineTo(w / 2, h);
      ctx.lineTo(0, h / 2);
      ctx.closePath();
      ctx.clip();
      draw(ctx);
      tex!.refresh();
    };
    const grad = (ctx: CanvasRenderingContext2D, x0: number, y0: number, x1: number, y1: number) => {
      const g = ctx.createLinearGradient(x0, y0, x1, y1);
      g.addColorStop(0, "rgba(8,12,26,0.85)");
      g.addColorStop(1, "rgba(8,12,26,0)");
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, w, h);
    };
    // Shadow cast from a higher WEST neighbour (shared NW edge).
    make("shade-w", (ctx) => grad(ctx, 10, 7, 42, 21));
    // From a higher NORTH neighbour (shared NE edge).
    make("shade-n", (ctx) => grad(ctx, w - 10, 7, w - 42, 21));
    // From a higher NW-diagonal neighbour (top corner).
    make("shade-nw", (ctx) => {
      const g = ctx.createRadialGradient(w / 2, 0, 0, w / 2, 0, 20);
      g.addColorStop(0, "rgba(8,12,26,0.7)");
      g.addColorStop(1, "rgba(8,12,26,0)");
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, w, h);
    });
  }

  /** Effective blocking height of a cell for shadow casting (solid structures
   * like trees count one level above their ground). */
  private effHeight(col: number, row: number, own: number): number {
    const cell = this.world?.rows[row]?.[col];
    if (!cell) return own; // off-map: no shade
    return cell.l + (surfaceFor(cell.t).standable ? 0 : 1);
  }

  /** Soft elliptical drop shadow (Mario 64 style): drawn once, reused by every
   * avatar. Squashed to the iso ground ratio so it reads as lying on the tile. */
  private ensureShadowTexture() {
    if (this.textures.exists(SHADOW_TEX)) return;
    const w = 64;
    const h = 26; // ISO_DY/ISO_DX ground squash
    const tex = this.textures.createCanvas(SHADOW_TEX, w, h);
    const ctx = tex!.getContext();
    ctx.save();
    ctx.scale(1, h / w); // draw a circle in a squashed space → ellipse on canvas
    const grd = ctx.createRadialGradient(w / 2, w / 2, 0, w / 2, w / 2, w / 2);
    grd.addColorStop(0, "rgba(0,0,0,0.62)");
    grd.addColorStop(0.65, "rgba(0,0,0,0.42)");
    grd.addColorStop(1, "rgba(0,0,0,0)");
    ctx.fillStyle = grd;
    ctx.fillRect(0, 0, w, w);
    ctx.restore();
    tex!.refresh();
  }

  /** Draw the art-free "Wanderer" fallback sprite into a texture once. A small
   * hooded figure with feet near the bottom (origin 0.5,0.9 matches real art).
   * White base so per-player tint (setTint) reads cleanly. */
  private ensurePlaceholderTexture() {
    if (this.textures.exists(PLACEHOLDER_TEX)) return;
    const g = this.make.graphics({ x: 0, y: 0 }, false);
    g.fillStyle(0xf1c9a5, 1).fillRect(11, 6, 10, 9); // head
    g.fillStyle(0x3b3b57, 1).fillRect(10, 4, 12, 4); // hood
    g.fillStyle(0xffffff, 1).fillRect(10, 14, 12, 12); // body (tinted per player)
    g.fillStyle(0xe0e0ea, 1).fillRect(9, 15, 2, 8).fillRect(21, 15, 2, 8); // arms
    g.fillStyle(0x2a2a44, 1).fillRect(11, 26, 4, 6).fillRect(17, 26, 4, 6); // legs
    g.generateTexture(PLACEHOLDER_TEX, 32, 34);
    g.destroy();
  }

  private drawGround() {
    const g = this.add.graphics();
    g.fillStyle(0x213a2c, 1).fillRect(0, 0, WORLD_WIDTH, WORLD_HEIGHT);
    g.lineStyle(1, 0x2b4a38, 1);
    for (let x = 0; x <= WORLD_WIDTH; x += 64) g.lineBetween(x, 0, x, WORLD_HEIGHT);
    for (let y = 0; y <= WORLD_HEIGHT; y += 64) g.lineBetween(0, y, WORLD_WIDTH, y);
    g.lineStyle(2, 0x86b7cf, 1).strokeRect(0, 0, WORLD_WIDTH, WORLD_HEIGHT);
    g.setDepth(-10000);
  }
}

function down(key?: Phaser.Input.Keyboard.Key): boolean {
  return !!key && key.isDown;
}

function sheetKey(uid: string, anim: string, dir: string): string {
  return `sheet:${uid}:${anim}:${dir}`;
}

function animKey(uid: string, anim: string, dir: string): string {
  return `anim:${uid}:${anim}:${dir}`;
}
