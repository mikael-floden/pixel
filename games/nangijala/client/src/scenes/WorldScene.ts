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
  BlockedFn,
  buildTerrainGrid,
  makeBlocked,
  isWalkableTerrain,
} from "@nangijala/shared";
import { CharacterDef, Manifest, stripUrl } from "../manifest";
import { colorForName } from "../placeholder";
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

interface Avatar {
  sprite: Phaser.GameObjects.Sprite;
  label: Phaser.GameObjects.Text;
  character: string;
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
  // Terrain collision — same grid the server uses, so prediction matches.
  private blocked: BlockedFn | undefined;
  private collisionOverlay?: Phaser.GameObjects.Graphics;

  constructor() {
    super("world");
  }

  init() {
    this.manifest = this.registry.get("manifest") as Manifest;
    this.myCharacter = this.registry.get("character") as CharacterDef;
    this.myName = this.registry.get("name") as string;
    this.world = (this.registry.get("world") as World | null) ?? null;
    if (this.world) {
      const grid = buildTerrainGrid(this.world.width, this.world.height, this.world.rows);
      this.blocked = makeBlocked(grid);
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
    this.buildAnimations();
    if (this.world) this.buildIsoGround();
    else this.drawGround();

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
    // Debug: press C to visualize blocked (non-walkable) terrain cells.
    this.input.keyboard!.on("keydown-C", () => this.toggleCollisionOverlay());

    const cam = this.cameras.main;
    cam.setBounds(0, 0, this.iso.w, this.iso.h);
    // Native 1:1 — pixel art is never scaled up.
    cam.setZoom(1);
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
      blockedAt: (x: number, y: number) => (this.blocked ? this.blocked(x, y) : false),
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
    if (!hasArt) sprite.setTint(colorForName(player.name || id));
    sprite.setOrigin(0.5, 0.9);
    const label = this.add
      .text(p0.x, p0.y, player.name, { fontFamily: "monospace", fontSize: "12px", color: "#eef" })
      .setOrigin(0.5, 1);
    this.avatars.set(id, { sprite, label, character: uid });
    this.applyAnimState(this.avatars.get(id)!, player.moving, player.running, player.dir);
  }

  update(_time: number, delta: number) {
    if (!this.room) return;
    const dt = delta / 1000;
    const myId = this.room.sessionId;
    this.predictAndSend(dt);

    const state = this.room.state as any;
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
        for (const p of this.pending) {
          const r = stepMovement(rx, ry, p.ax, p.ay, p.running, p.dt, this.blocked);
          rx = r.x;
          ry = r.y;
        }
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
      // the sprite toward it (snappier for the local player).
      const target = this.project(tx, ty);
      const k = Math.min(1, dt * (id === myId ? 30 : 12));
      av.sprite.x += (target.x - av.sprite.x) * k;
      av.sprite.y += (target.y - av.sprite.y) * k;
      av.sprite.setDepth(av.sprite.y);
      const topY = av.sprite.y - av.sprite.displayHeight * 0.9;
      av.label.setPosition(av.sprite.x, topY - 4);
      if (av.bubble) {
        av.bubble.setPosition(av.sprite.x, topY - 18);
        if (this.time.now > (av.bubbleUntil ?? 0)) {
          av.bubble.destroy();
          av.bubble = undefined;
        }
      }
      this.applyAnimState(av, moving, running, dir);
    });
  }

  private predictAndSend(dt: number) {
    const k = this.keys;
    const ax = (down(k.D) || down(k.RIGHT) ? 1 : 0) - (down(k.A) || down(k.LEFT) ? 1 : 0);
    const ay = (down(k.S) || down(k.DOWN) ? 1 : 0) - (down(k.W) || down(k.UP) ? 1 : 0);
    const running = down(k.SHIFT);
    this.lastInput = { ax, ay, running };
    const sig = `${ax},${ay},${running ? 1 : 0}`;
    this.sendAccum += dt;
    // Send on change, or at the input tick, tagging each with a sequence number
    // so the server can ack it and the client can reconcile.
    if (sig !== this.lastSent || this.sendAccum >= 1 / INPUT_HZ) {
      this.inputSeq += 1;
      this.pending.push({ seq: this.inputSeq, ax, ay, running, dt: this.sendAccum });
      const msg: InputMessage = { ax, ay, running, seq: this.inputSeq };
      this.room!.send("input", msg);
      this.lastSent = sig;
      this.sendAccum = 0;
    }
  }

  private applyAnimState(av: Avatar, moving: boolean, running: boolean, dir: string) {
    const state = moving ? (running ? "run" : "walk") : "idle";
    const d = DIRECTIONS.includes(dir as never) ? dir : DEFAULT_DIRECTION;
    const key = this.resolveAnim(av.character, state, d);
    if (key && av.sprite.anims.getName() !== key) av.sprite.play(key, true);
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

  /** Composite the isometric world (with elevation) into a static ground texture. */
  private buildIsoGround() {
    const world = this.world!;
    const { dx, dy, lh } = MAP_GEOMETRY;
    const { w, h, ox, oy } = canvasSize(world);
    this.iso = { ox, oy, w, h };

    const rt = this.add.renderTexture(0, 0, w, h).setOrigin(0, 0).setDepth(-1_000_000);
    rt.fill(0x181c28, 1);
    rt.beginDraw();
    for (const { x, y, cell } of drawOrder(world)) {
      const key = tileKey(cell.t, cell.v);
      if (!this.textures.exists(key)) continue;
      const bx = ox + (x - y) * dx;
      const by = oy + (x + y) * dy;
      for (let lvl = 0; lvl <= cell.l; lvl++) rt.batchDraw(key, bx, by - lvl * lh);
    }
    rt.endDraw();
  }

  /** Toggle a debug overlay marking blocked (non-walkable) cells in red iso
   * diamonds. Built lazily on first use. */
  private toggleCollisionOverlay() {
    if (this.collisionOverlay) {
      this.collisionOverlay.setVisible(!this.collisionOverlay.visible);
      return;
    }
    if (!this.world) return;
    const { dx, dy, lh } = MAP_GEOMETRY;
    const g = this.add.graphics().setDepth(1_000_000);
    g.fillStyle(0xff3b3b, 0.35);
    for (let row = 0; row < this.world.height; row++) {
      for (let col = 0; col < this.world.width; col++) {
        const cell = this.world.rows[row]?.[col];
        if (!cell || isWalkableTerrain(cell.t)) continue;
        const bx = this.iso.ox + (col - row) * dx;
        const by = this.iso.oy + (col + row) * dy - cell.l * lh;
        // The top diamond of a 64-wide iso tile (half-width dx, half-height dy).
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
