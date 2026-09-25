/** A LOADED IMAGE LETS GO OF ITS LOADER.
 *
 *  Phaser's ImageFile decodes by pointing an `<img>` at a blob URL and waiting
 *  for its load: the onload closure holds the File, the File holds its
 *  XMLHttpRequest (`File.destroy` never drops `xhrLoader`), and the request
 *  holds the response Blob. The `<img>` is the texture's SOURCE for as long as
 *  the texture lives (a context restore re-uploads from it), so every image a
 *  loader ever brought in kept its File, its request, the compressed bytes and
 *  two listeners alive with it — headless after two minutes, 1,234 requests;
 *  on his phone, every terrain tile and character frame loaded that session.
 *  None of it is garbage the collector can drop, and all of it is Blink
 *  objects it must TRACE on every major collection (V8's trace: 20-28 ms of
 *  embedder tracing a cycle, single incremental steps up to 14-20 ms).
 *
 *  Cleared at FILE_COMPLETE, which Phaser emits from inside that very onload
 *  (`File.pendingDestroy` after `onProcessComplete`): both handlers have done
 *  their work, nothing sets them again, and the image itself — its pixels,
 *  its src, its place as the texture's source — is untouched. */
export function releaseLoadedImage(data: unknown): boolean {
  // Looked up on globalThis, so the module also compiles (and is tested) where there is no DOM.
  const Img = (globalThis as { HTMLImageElement?: abstract new () => object }).HTMLImageElement;
  if (!Img || !(data instanceof Img)) return false;
  const img = data as { onload: unknown; onerror: unknown };
  img.onload = null;
  img.onerror = null;
  return true;
}

/** Hook a loader (`this.load`, the terrain's own LoaderPlugin) so every image
 *  it completes lets go of its File. `event` is Phaser's FILE_COMPLETE, passed
 *  in so this module needs no Phaser (the tests run it in node). A loader
 *  drops its listeners on scene shutdown, so hook it where it is (re)armed. */
export function releaseImagesOnComplete(
  loader: { on(event: string, fn: (key: string, type: string, data: unknown) => void): unknown },
  event: string,
): void {
  loader.on(event, (_key, _type, data) => {
    releaseLoadedImage(data);
  });
}
