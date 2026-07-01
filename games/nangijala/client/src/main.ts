import Phaser from "phaser";
import { loadManifest } from "./manifest";
import { chooseCharacter } from "./select";
import { WorldScene } from "./scenes/WorldScene";
import { loadWorld } from "./maps";
import { MapPreviewScene } from "./scenes/MapPreviewScene";

async function bootMapPreview(): Promise<boolean> {
  if (location.hash !== "#map") return false;
  const world = await loadWorld();
  if (!world) {
    document.body.innerHTML =
      '<p style="color:#eef;font-family:monospace;padding:2rem">No map yet ' +
      "(pixel/maps/world/world.json not found).</p>";
    return true;
  }
  const game = new Phaser.Game({
    type: Phaser.AUTO,
    parent: "game",
    backgroundColor: "#12121c",
    pixelArt: true,
    scale: { mode: Phaser.Scale.RESIZE, width: window.innerWidth, height: window.innerHeight },
    scene: [MapPreviewScene],
  });
  game.registry.set("world", world);
  return true;
}

async function boot() {
  if (await bootMapPreview()) return;
  const manifest = await loadManifest();
  if (!manifest.characters.length) {
    document.body.innerHTML =
      '<p style="color:#eef;font-family:monospace;padding:2rem">No characters found. ' +
      "Run <code>npm run manifest</code> and ensure the pixel submodule is initialised.</p>";
    return;
  }

  // The isometric tile world (may be null if the maps submodule isn't present;
  // the world scene falls back to a plain ground in that case).
  const world = await loadWorld();

  // Pre-join screen: pick any generated character + a name, then enter the world.
  const { character, name } = await chooseCharacter(manifest);

  const game = new Phaser.Game({
    type: Phaser.AUTO,
    parent: "game",
    backgroundColor: "#12121c",
    pixelArt: true,
    scale: {
      mode: Phaser.Scale.RESIZE,
      width: window.innerWidth,
      height: window.innerHeight,
    },
    scene: [WorldScene],
  });

  game.registry.set("manifest", manifest);
  game.registry.set("character", character);
  game.registry.set("name", name);
  game.registry.set("world", world);
}

boot();
