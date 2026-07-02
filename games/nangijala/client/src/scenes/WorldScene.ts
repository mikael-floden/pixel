import Phaser from "phaser";
import { Room, getStateCallbacks } from "colyseus.js";
import {
  WORLD_WIDTH,
  WORLD_HEIGHT,
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
  surfaceFor,
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
const INPUT_HZ = 20;
const BUBBLE_MS = 5000;
const PLACEHOLDER_TEX = "placeholder:wanderer";
const SHADOW_TEX = "avatar:shadow";
// Emissive tile categories → coloured spot lights (glow day and night).
const EMISSIVE: Record<string, { color: number; radius: number }> = {
  lava: { color: 0xff7433, radius: 110 },
  crystal_ground: { color: 0x86d9ff, radius: 75 },
  crystal_spire: { color: 0x9db8ff, radius: 110 },
  mushroom_grove: { color: 0x5fc4ff, radius: 65 },
};
const MAX_EMISSIVE = 48; // cap per view (perf)
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
  hopUntil: number;
  swimming: boolean;
  baseTint: number;
  pulse: number; // aura pulse phase (per player, so auras don't sync)
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
  private atmo!: Atmosphere;
  private auraOn = true;

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
    }
  }

  async create() {
    this.ensurePlaceholderTexture();
    this.ensureShadowTexture();
    this.ensureShadeTextures();
    this.buildAnimations();
    if (this.world) this.setupStreamingGround();
    else this.drawGround();

    this.atmo = new Atmosphere(this);
    this.atmo.create();

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
    // Debug: press C to visualize water (swimmable) terrain cells.
    this.input.keyboard!.on("keydown-C", () => this.toggleCollisionOverlay());
    // V toggles the character aura (A/B the Sea-of-Stars-style glow live).
    this.input.keyboard!.on("keydown-V", () => {
      this.auraOn = !this.auraOn;
      this.chat.addLog("—", `Character aura: ${this.auraOn ? "on" : "off"}`);
    });
    // Atmosphere: L cycles time-of-day (day/dusk/night/dawn), G toggles fog.
    this.input.keyboard!.on("keydown-L", () => this.chat.addLog("—", `Time of day: ${this.atmo.cyclePreset()}`));
    this.input.keyboard!.on("keydown-G", () => this.chat.addLog("—", `Fog: ${this.atmo.toggleFog() ? "on" : "off"}`));

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
      timeOfDay: (name: string) => this.atmo.setPreset(name),
      toggleFog: () => this.atmo.toggleFog(),
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
      hopUntil: 0,
      swimming: false,
      baseTint,
      pulse: [...id].reduce((h, ch) => h + ch.charCodeAt(0), 0) % 63,
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
        // Sprite bounds with margin: walk frames can dip feet a few px below
        // the measured idle anchor, so pad the box or edge stamps get missed.
        const sx0 = av.lx - av.sprite.displayWidth / 2 - 4;
        const sx1 = av.lx + av.sprite.displayWidth / 2 + 4;
        const sy0 = av.sprite.y - av.sprite.displayHeight - 4;
        const sy1 = av.sprite.y + 8;
        let above = -Infinity;
        let below = Infinity;
        for (const o of this.occluderMeta) {
          if (o.x1 < sx0 || o.x0 > sx1 || o.y1 < sy0 || o.y0 > sy1) continue;
          const t0 = Math.max(o.col - colf, o.row - rowf);
          const t1 = Math.min(o.col + 1 - colf, o.row + 1 - rowf);
          const blocks = o.top > lvl && t1 > Math.max(t0, 0);
          if (blocks) below = Math.min(below, o.depth);
          else above = Math.max(above, o.depth);
        }
        if (above > -Infinity) depth = Math.max(depth, above + 0.6);
        if (below < Infinity) depth = Math.min(depth, below - 0.3); // walls win conflicts
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
        .setDepth(av.sprite.depth - 0.5);
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

    // Atmosphere: each player is a light source (lantern at the torso).
    // Each player contributes a night lantern pool + a dim, slowly pulsing
    // aura (Sea of Stars-style) that grounds the character in the scene.
    const tsec = this.time.now / 1000;
    const lights: LightSource[] = [];
    for (const a of this.avatars.values()) {
      const pulse = Math.sin(tsec * 1.3 + a.pulse) * 0.5 + Math.sin(tsec * 4.7 + a.pulse * 2) * 0.2;
      lights.push({ x: a.lx, y: a.ly - 20 }); // lantern pool (night)
      if (!this.auraOn) continue;
      lights.push({
        x: a.lx,
        y: a.ly - 16,
        color: 0xffe3b3,
        radius: 46 + pulse * 5,
        alpha: 0.15 + pulse * 0.05,
      });
    }
    lights.push(...this.emissiveLights);
    this.atmo.update(lights, this.cameras.main, dt);
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
        // Contact shadows from higher sun-side neighbours (elevation contrast).
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

    const { dx, dy, lh, tile: tileSize } = MAP_GEOMETRY;
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
        // Emissive tiles become coloured spot lights (fed to the atmosphere).
        const em = EMISSIVE[cell.t];
        if (em && this.emissiveLights.length < MAX_EMISSIVE) {
          this.emissiveLights.push({
            x: this.iso.ox + u * dx + dx,
            y: this.iso.oy + v * dy + dy - cell.l * lh,
            color: em.color,
            radius: em.radius,
          });
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
        // Match the ground pass's contact shadows on redrawn column tops.
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
