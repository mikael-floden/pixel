// WHAT CHANGED BETWEEN YOUR BUILD AND THE SERVED ONE — the update popup's
// release notes (maintainer 2026-09-18: "when the game shows a popup with a new
// version being available I want it to list everything that has changed from
// the version I'm currently at to the version I'm about to get. See wiki
// release notes for inspiration … Think about the UI/UX and make it look nice!
// Yes this dialog/modal will be bigger but that's OK").
//
// THE DATA IS THE WIKI'S, NOT A SECOND COPY. `wiki/lib/releases.mjs` already
// publishes the last 50 commits ending at the build being served —
// `wiki/release_notes.json`, schema `pixel-wiki-releases@1`, regenerated into
// the build context by the deploy (wiki/README.md "Release Notes") and served
// from the image at /assets/wiki/release_notes.json. So the file the OLD client
// fetches from the NEW server is that deploy's own list, and the range is a
// SLICE of it: from its head down to (not including) the sha this build is
// running. Nothing here re-derives a changelog, and a wiki-side change to how a
// commit is attributed shows up in the game with no edit on this side.
// `cache: "no-store"` because the static mount sets maxAge 1h — a cached copy
// would describe the deploy before last.
//
// THE CHIPS WEAR THE THEME, NOT A PALETTE OF THEIR OWN (maintainer 2026-09-19:
// "I don't like the pill colors (doesn't follow the CSS)"). They were a hue
// derived from the area's name — twelve arbitrary colours over his beige/dark
// tokens, which is exactly what a shared theme exists to prevent. One recipe
// now, the same one the sha chip beside the title already used: --surface-2 on
// --border with --muted ink. What tells two areas apart is the WORD.
//
// AND THE WORD IS HIS NAME FOR THE AGENT, not the board's filename. The wiki
// attributes a commit to a `coordination/<agent>.json` (wiki/lib/releases.mjs),
// so the raw ids are `games-ui`, `games-perf`, `maps2`, `characters2`,
// `scenery-github-agent` — and he calls those UI, Optimization, Map, Character
// and Scenery GitHub. AGENTS is that map, with the two suffixes derived rather
// than listed (`-assistant`, `-github-agent`), so an agent hired tonight is
// recognised the moment its board exists — the same rule the wiki's own roster
// follows. An id with no entry is shown AS IT IS: a name we have not been told
// is still a fact, and inventing a prettier one would hide which board pushed.
//
// IT IS THE WIKI'S ADMIN LIST MADE READABLE, which is the "inspiration" part:
// the wiki shows raw rows on purpose (maintainer 2026-09-13: "no curation, no
// versions, no grouping by feature" — ADMIN-ONLY). Here the same rows are
// grouped by DAY, the area is a coloured chip instead of a column, the chip's
// own token is stripped off the front of the subject so it is not said twice,
// and a run of identical subjects collapses to a count. NOTHING IS FILTERED —
// he asked for everything, so a `live:` admin commit is a row like any other.
//
// THE TOAST IS UNCHANGED (main.ts showUpdateBanner): its wording is
// maintainer-fixed ("New version out <hash>", 2026-07-17) and it stays the
// quiet FYI he asked for in 2026-08-05 — deploys land many times an hour and a
// modal that opened itself over the world every time would be the opposite of
// quiet. Tapping it opens this dialog; the dialog's primary button reloads, so
// the update is still two taps from anywhere.
import { gameUrl } from "./staging";
import { sessionSet } from "./sessionflag";

/** One row of `pixel-wiki-releases@1`. */
interface ReleaseCommit {
  sha: string;
  at: string;
  author: string;
  subject: string;
  /** The agent the wiki attributed it to, or null when no signal answered. */
  agent: string | null;
  /** The top-level folders the commit touched — the fact the wiki shows when
   *  no agent can be named (a folder never names an agent). */
  dirs: string[];
  files: number;
}

interface ReleaseDoc {
  head: string;
  commits: ReleaseCommit[];
}

const NOTES_URL = "/assets/wiki/release_notes.json";
const CSS_ID = "ml-updatenote-css";

/** The wiki's published list, or null if it is not there (a deploy whose
 *  context had no git, an older image, an offline phone). The dialog must open
 *  and the reload must work either way — the notes are the nice-to-have. */
/** The fetch, started ONCE and remembered. */
let notesPromise: Promise<ReleaseDoc | null> | null = null;
/** The answer, once it is in hand — read synchronously when the card is built.
 *  `notesDone` is separate because a FAILED fetch is also an answer (null). */
let notesReady: ReleaseDoc | null = null;
let notesDone = false;

/**
 * START THE FETCH BEFORE THE PLAYER CAN ASK FOR IT (maintainer 2026-09-19:
 * "Once we know a new version is out we fetch the data we need and after that
 * we display a 'new version out' popup to the player. When the player clicks
 * on the new version out toast the dialog will display with the best possible
 * size immediately… The key here is we have the data already when we create
 * the dialog"). main.ts calls this the moment it learns a new build is served
 * and raises the toast on the answer, so by the time the toast is tappable the
 * list is known — and the card can be built whole, measured by its own
 * content, and inserted at its final size. That is what removed the loading
 * state rather than styling it.
 * Memoised and never rejecting: a failed fetch resolves null and the dialog
 * says so, exactly as it did when it fetched on open.
 */
export function prefetchNotes(): Promise<ReleaseDoc | null> {
  if (!notesPromise)
    notesPromise = loadNotes().then((d) => {
      notesReady = d;
      notesDone = true;
      return d;
    });
  return notesPromise;
}

async function loadNotes(): Promise<ReleaseDoc | null> {
  try {
    const res = await fetch(gameUrl(NOTES_URL), { cache: "no-store" });
    if (!res.ok) return null;
    const doc = (await res.json()) as { head?: unknown; commits?: unknown };
    if (!Array.isArray(doc.commits)) return null;
    const commits = (doc.commits as Record<string, unknown>[])
      .filter((c) => c && typeof c.sha === "string" && typeof c.subject === "string")
      .map<ReleaseCommit>((c) => ({
        sha: String(c.sha),
        at: typeof c.at === "string" ? c.at : "",
        author: typeof c.author === "string" ? c.author : "",
        subject: String(c.subject),
        agent: typeof c.agent === "string" ? c.agent : null,
        dirs: Array.isArray(c.dirs) ? (c.dirs as unknown[]).filter((d): d is string => typeof d === "string") : [],
        files: typeof c.files === "number" ? c.files : 0,
      }));
    return { head: typeof doc.head === "string" ? doc.head : "", commits };
  } catch {
    return null;
  }
}

/** Git abbreviates to whatever length is unambiguous, so the file's shas, the
 *  badge's 9 chars and /version's full hash are all the same commit at
 *  different lengths — compare on the shorter one, never for equality. */
function sameSha(a: string, b: string): boolean {
  const n = Math.min(a.length, b.length);
  return n >= 7 && a.slice(0, n) === b.slice(0, n);
}

/** The commits between the running build and the served one, newest first.
 *  `truncated` = this build is further back than the wiki's 50-commit window
 *  (or is not in it at all), so the list is what is known, not the whole range
 *  — said out loud rather than quietly implied. */
export function sliceSince(doc: ReleaseDoc, mySha: string): { rows: ReleaseCommit[]; truncated: boolean } {
  const i = doc.commits.findIndex((c) => sameSha(c.sha, mySha));
  if (i < 0) return { rows: doc.commits, truncated: doc.commits.length > 0 };
  return { rows: doc.commits.slice(0, i), truncated: false };
}

/** The area a row belongs to, as the WIKI names it: the agent it attributed
 *  the commit to, else the folder it touched, else the repo root. One value,
 *  because the chip is a glance, not a report — and the RAW one, because
 *  `cleanSubject` matches it against the subject's own prefix. */
function areaOf(c: ReleaseCommit): string {
  return c.agent || c.dirs[0] || "repo";
}

/** HIS NAMES for the boards and the domains (2026-09-19). Only the stems: the
 *  `-assistant` and `-github-agent` suffixes are derived below, so a new board
 *  of either kind needs no entry here. */
const AGENTS: Record<string, string> = {
  games: "Game",
  games2: "Game",
  "games-ui": "UI",
  "games-ambient": "Ambient",
  "games-perf": "Optimization",
  "games-audio": "Composer",
  maps: "Map",
  maps2: "Map",
  tiles: "Tiles",
  tiles2: "Tiles",
  monsters: "Monster",
  scenery: "Scenery",
  characters2: "Character",
  items: "Item",
  item: "Item",
  lore: "Lore",
  wiki: "Wiki",
  account: "Account",
  sounds: "Sound",
  music: "Music",
  live: "Live",
  coordination: "Boards",
  ".github": "CI",
  repo: "Repo",
};

/** The chip's word: his name for the board, with the suffix its kind carries.
 *  An unknown id is shown unchanged rather than guessed at. */
export function areaLabel(id: string): string {
  for (const [suffix, tail] of [
    ["-github-agent", "GitHub"],
    ["-github", "GitHub"],
    ["-assistant", "assistant"],
  ] as const) {
    if (id.endsWith(suffix)) {
      const stem = id.slice(0, -suffix.length);
      return `${AGENTS[stem] ?? stem} ${tail}`;
    }
  }
  return AGENTS[id] ?? id;
}

/** Drop the leading `token:` the commit subject opens with WHEN that token is
 *  the thing the chip already says ("games2: the thumb row balances…" beside a
 *  games2 chip). Anything else is left exactly as written — a subject is the
 *  author's sentence, and a generic strip would eat the first word of one that
 *  simply starts with a colon-ish phrase. */
export function cleanSubject(c: ReleaseCommit): string {
  const m = /^([A-Za-z0-9][\w-]*)(?:\s+(?:board|agent))?:\s*(.+)$/s.exec(c.subject);
  if (!m) return c.subject;
  const token = m[1].toLowerCase();
  const known = [areaOf(c), ...c.dirs, c.agent ?? ""]
    .filter(Boolean)
    .map((s) => s.toLowerCase())
    .flatMap((s) => [s, s.replace(/-assistant$/, ""), s.replace(/\d+$/, "")]);
  return known.includes(token) ? m[2] : c.subject;
}

/** Adjacent rows with the same area AND the same cleaned subject become one
 *  row with a count — three identical `live: admin update` commits in a row are
 *  one thing that happened three times, and printing them out is noise he has
 *  to scroll past. */
interface Row {
  area: string;
  text: string;
  at: string;
  sha: string;
  count: number;
}
function collapse(rows: ReleaseCommit[]): Row[] {
  const out: Row[] = [];
  for (const c of rows) {
    const area = areaOf(c);
    const text = cleanSubject(c);
    const last = out[out.length - 1];
    if (last && last.area === area && last.text === text) last.count++;
    else out.push({ area, text, at: c.at, sha: c.sha, count: 1 });
  }
  return out;
}

const dayMs = 86_400_000;
/** "Today" / "Yesterday" / "Thu 18 Sep" — the header a changelog is read by. */
function dayLabel(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const midnight = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const days = Math.round((midnight(new Date()) - midnight(d)) / dayMs);
  if (days === 0) return "Today";
  if (days === 1) return "Yesterday";
  return d.toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" });
}
const timeLabel = (iso: string) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
};

function styleOnce() {
  if (document.getElementById(CSS_ID)) return;
  const st = document.createElement("style");
  st.id = CSS_ID;
  // The drop-quantity dialog's recipe (hud.ts .ml-qty) — a blurred backdrop
  // and a wiki card on the shared tokens — but z 110: the toast that opens it
  // is z 100 and must not sit over its own dialog. The card is the tall one he
  // approved ("yes this dialog will be bigger but that's OK"): it takes the
  // height it can get and scrolls the LIST only, so the title and the buttons
  // stay put while fifty rows move under them.
  st.textContent = `
  .ml-upd-back{position:fixed;inset:0;z-index:110;display:flex;align-items:center;justify-content:center;
    padding:16px;box-sizing:border-box;background:rgba(0,0,0,.5);
    backdrop-filter:blur(3px);-webkit-backdrop-filter:blur(3px)}
  /* IT OPENS AT THE SIZE ITS CONTENT NEEDS, and it never changes afterwards
     (maintainer 2026-09-19: "We need to know the best dialog size when we
     open/before we open the dialog… some versions with only a small number of
     changes can use a smaller dialog and some with lots of changes uses a
     taller dialog with scroll"). That is max-height, not height — a FIXED
     height was the first answer to "I hate dialogs that suddenly changes size"
     and it was the wrong one: it made two commits look like fifty, and an
     EMPTY list a full-screen empty box. The size never jumps because the rows
     are already in the card when it is inserted (prefetchNotes), not because
     the box was nailed down. */
  .ml-upd{width:min(460px,100%);max-height:min(720px,calc(100dvh - 32px));display:flex;flex-direction:column;
    box-sizing:border-box;background:var(--bg);color:var(--ink);
    border:1px solid var(--border);border-radius:16px;box-shadow:var(--shadow);
    font:14px/1.45 var(--sans);overflow:hidden}
  .ml-upd *{box-sizing:border-box}
  .ml-upd-head{flex:none;padding:16px 16px 12px;border-bottom:1px solid var(--border)}
  .ml-upd-title{display:flex;align-items:baseline;gap:8px;flex-wrap:wrap}
  .ml-upd-title h2{margin:0;font:700 17px/1.2 var(--sans)}
  .ml-upd-sha{font:600 11px/1 var(--mono, ui-monospace, monospace);letter-spacing:.06em;color:var(--muted);
    background:var(--surface-2);border:1px solid var(--border);border-radius:6px;padding:4px 6px}
  .ml-upd-sub{margin-top:6px;color:var(--muted);font-size:12.5px}
  /* The area summary: what this update is MADE OF, before you read a row of
     it. Informational only — nothing here is tappable, so nothing invites a
     tap that does nothing. */
  .ml-upd-areas{display:flex;flex-wrap:wrap;gap:5px;margin-top:10px}
  .ml-upd-areas span{font:600 11px/1 var(--sans);padding:4px 7px;border-radius:6px;white-space:nowrap;
    background:var(--surface-2);border:1px solid var(--border);color:var(--muted)}
  /* NO -webkit-overflow-scrolling:touch. It is a no-op on every browser this
     game runs on (momentum scrolling has been the default since iOS 13) and it
     is what left ROWS PAINTED OVER THE STICKY DAY BAND while scrolling
     (maintainer 2026-09-19: "a buggy 'today' banner that leaves some pixels
     over it so when I scroll I can see the pixels over that pinned heading").
     It puts the scroller on its own compositor layer whose sticky child is not
     repainted per frame; the trails are that layer, not a z-order bug. */
  .ml-upd-list{flex:1 1 auto;min-height:0;overflow-y:auto;padding:4px 16px 12px;position:relative}
  /* …and the band is FULL-BLEED and opaque: it used to be as wide as the
     list's content box, so a row sliding under it showed in the 16px gutters.
     Negative margins + matching padding take it edge to edge, z 2 keeps it
     over every row, and the hairline under it is what makes it read as a band
     rather than a word floating on the rows. */
  .ml-upd-day{position:sticky;top:-4px;z-index:2;background:var(--bg);
    margin:0 -16px;padding:12px 16px 6px;color:var(--muted);
    box-shadow:0 1px 0 var(--border);
    font:600 11px/1.2 var(--sans);letter-spacing:.09em;text-transform:uppercase}
  .ml-upd-row{display:flex;gap:9px;padding:7px 0;border-top:1px solid var(--border)}
  .ml-upd-day + .ml-upd-row{border-top:none}
  /* ONE recipe, the sha chip's — the theme's own surface, border and muted
     ink. No per-area colour: the WORD is what tells them apart. */
  .ml-upd-chip{flex:none;align-self:flex-start;max-width:120px;overflow:hidden;text-overflow:ellipsis;
    white-space:nowrap;font:600 11px/1.45 var(--sans);padding:2px 7px;border-radius:6px;
    background:var(--surface-2);border:1px solid var(--border);color:var(--muted)}
  .ml-upd-body{min-width:0;flex:1 1 auto}
  .ml-upd-subj{overflow-wrap:anywhere}
  .ml-upd-x{color:var(--muted);font-weight:700;font-size:12px}
  .ml-upd-meta{margin-top:2px;color:var(--muted);font:11px/1.3 var(--mono, ui-monospace, monospace)}
  .ml-upd-note{padding:10px 0 2px;color:var(--muted);font-size:12.5px;text-align:center}
  /* THE LOADER SITS SLIGHTLY ABOVE CENTRE (maintainer 2026-09-19: "during the
     loading you display a loading animation in the center of the dialog.
     Actually slightly over center usually looks better. Like 55% (45% from the
     div top)"). Its CENTRE is at 45% of the list's height — optical centre,
     which is where the eye expects the middle of a box to be. */
  .ml-upd-load{position:absolute;left:0;right:0;top:45%;transform:translateY(-50%);
    display:flex;flex-direction:column;align-items:center;gap:12px;pointer-events:none}
  .ml-upd-spin{width:30px;height:30px;border-radius:50%;
    border:3px solid var(--border);border-top-color:var(--accent);
    animation:ml-upd-spin 820ms linear infinite}
  .ml-upd-load span{color:var(--muted);font:600 12px/1.2 var(--sans);letter-spacing:.04em}
  @keyframes ml-upd-spin{to{transform:rotate(360deg)}}
  @media (prefers-reduced-motion:reduce){.ml-upd-spin{animation-duration:2.4s}}
  /* YOUR OWN BUILD, always last and never mistakable for one of the new ones
     (maintainer 2026-09-19: "it has to be clear this is my version and not part
     of the commit — so my commit should always be at the bottom and marked").
     A rule above it ends the list, the row wears the accent rather than the
     plain surface, and it carries a label instead of a day heading. */
  .ml-upd-mine{margin-top:14px;padding-top:12px;border-top:2px solid var(--border-strong)}
  .ml-upd-mine .ml-upd-row{border-top:none;background:var(--accent-soft);
    border:1px solid var(--accent);border-radius:10px;padding:8px 10px}
  .ml-upd-mine .ml-upd-chip{background:var(--bg);border-color:var(--accent);color:var(--accent-ink)}
  .ml-upd-mine .ml-upd-subj{color:var(--ink)}
  .ml-upd-youre{display:flex;align-items:center;gap:7px;padding:0 0 7px;
    color:var(--accent-ink);font:700 11px/1.2 var(--sans);letter-spacing:.09em;text-transform:uppercase}
  .ml-upd-youre::after{content:"";flex:1 1 auto;height:1px;background:var(--accent);opacity:.45}
  .ml-upd-foot{flex:none;display:grid;grid-template-columns:1fr 1.4fr;gap:8px;
    padding:12px 16px calc(12px + var(--ml-safe-bottom, 0px));border-top:1px solid var(--border)}
  .ml-upd-btn{min-height:44px;padding:8px 12px;border-radius:10px;cursor:pointer;
    font:600 14px var(--sans);background:var(--surface);color:var(--ink);border:1px solid var(--border);
    -webkit-tap-highlight-color:transparent;user-select:none}
  .ml-upd-btn:active{transform:translateY(1px)}
  /* The primary is the accent PLATE the HUD uses for a chosen thing, not a new
     colour: reloading is the expected action, and "Later" beside it is the
     plain surface. */
  .ml-upd-btn.go{background:var(--accent-soft);border-color:var(--accent);color:var(--accent-ink)}`;
  document.head.appendChild(st);
}

let open: HTMLElement | null = null;

/** Close the dialog if it is open (idempotent). */
export function closeUpdateNotes(): void {
  open?.remove();
  open = null;
}

/**
 * Open the release notes for the served build. `mySha` defaults to this
 * build's own stamp, which is what the toast wants; the gate passes its own.
 * Never throws and never waits for the notes to open — the card appears at
 * once and fills in, because the button that reloads has to be reachable even
 * when the file is missing.
 */
export function openUpdateNotes(newSha: string, mySha?: string): HTMLElement {
  closeUpdateNotes();
  styleOnce();
  const mine = mySha ?? ((import.meta.env.VITE_GIT_SHA as string | undefined) || "dev");
  const back = document.createElement("div");
  back.className = "ml-upd-back";
  const card = document.createElement("div");
  card.className = "ml-upd";
  card.setAttribute("role", "dialog");
  card.setAttribute("aria-label", "New version");

  const head = document.createElement("div");
  head.className = "ml-upd-head";
  // The TITLE repeats the toast's maintainer-fixed sentence, so the thing he
  // tapped and the thing that opened are plainly the same thing.
  head.innerHTML =
    `<div class="ml-upd-title"><h2>New version out</h2>` +
    `<span class="ml-upd-sha">${newSha.slice(0, 9)}</span></div>` +
    `<div class="ml-upd-sub">&nbsp;</div>` +
    `<div class="ml-upd-areas"></div>`;
  const sub = head.querySelector(".ml-upd-sub") as HTMLElement;
  const areas = head.querySelector(".ml-upd-areas") as HTMLElement;

  const list = document.createElement("div");
  list.className = "ml-upd-list";
  // THE CARD IS ALREADY ITS FINAL SIZE (the .ml-upd height rule), so this only
  // has to say "working" — it is removed, not replaced, and nothing moves.
  const loading = document.createElement("div");
  loading.className = "ml-upd-load";
  loading.innerHTML = '<div class="ml-upd-spin" aria-hidden="true"></div><span>Loading what changed…</span>';
  loading.setAttribute("role", "status");
  list.appendChild(loading);

  const foot = document.createElement("div");
  foot.className = "ml-upd-foot";
  const later = document.createElement("button");
  later.type = "button";
  later.className = "ml-upd-btn";
  later.textContent = "Later";
  later.addEventListener("click", closeUpdateNotes);
  const go = document.createElement("button");
  go.type = "button";
  go.className = "ml-upd-btn go";
  go.textContent = "Update now";
  // UPDATING FROM INSIDE THE WORLD COMES BACK INTO THE WORLD (maintainer
  // 2026-09-19: "If I'm inside the game and a new version is out. If I open the
  // dialog and press upgrade the game restarts and I'm back at the
  // title-screen/character select. It would be much smoother to first reload
  // the game of course, but then immediately get into loading the game. This
  // will take me back to where I was so much faster"). `ml-rejoin` is exactly
  // that instruction and it already exists: WorldScene sets it before its
  // dead-connection recovery reload, main.ts's fast path consumes it, skips the
  // select screen, shows the loading overlay and re-enters with the remembered
  // choice (ml-last-choice) — the server restores the position from the token
  // store. So this adds no state and no second way of doing the same thing.
  // ONLY FROM THE WORLD: the same dialog opens over the CHARACTER SELECT, and
  // there the flag would skip the very screen he is standing on. `ml-ingame` is
  // the root class main.ts sets when the game starts, so it is the question
  // "am I in the world" asked of the thing that answers it.
  go.addEventListener("click", () => {
    if (document.documentElement.classList.contains("ml-ingame")) sessionSet("ml-rejoin", "1");
    location.reload();
  });
  foot.append(later, go);

  card.append(head, list, foot);
  back.appendChild(card);
  back.addEventListener("click", (e) => {
    if (e.target === back) closeUpdateNotes();
  });
  const onKey = (e: KeyboardEvent) => {
    if (e.key !== "Escape") return;
    closeUpdateNotes();
    window.removeEventListener("keydown", onKey);
  };
  window.addEventListener("keydown", onKey);
  // THE CARD IS FILLED BEFORE IT IS INSERTED whenever the notes are already in
  // hand — which is the ordinary case, because main.ts prefetches them before
  // it raises the toast. Nothing is measured, nothing is animated: the card
  // enters the document at its final size, so there is no size to change and
  // no loading state to show. The `.then` below is the RACE path only (the
  // dialog opened from a probe, or the fetch is still in the air), and it is
  // the only path that ever shows the spinner.
  const fill = (doc: ReleaseDoc | null) => {
    if (!doc || !doc.commits.length) {
      sub.textContent = `Your build is ${mine.slice(0, 9)}. The change list is not published for this deploy.`;
      return;
    }
    const { rows, truncated } = sliceSince(doc, mine);
    if (!rows.length) {
      sub.textContent = `Your build is ${mine.slice(0, 9)} — nothing listed between it and this one.`;
      return;
    }
    const n = rows.length;
    sub.textContent =
      `${n} change${n === 1 ? "" : "s"} since your build ${mine.slice(0, 9)}` +
      (truncated ? " — the most recent ones" : "");
    // area summary, most changes first
    const byArea = new Map<string, number>();
    for (const c of rows) {
      const k = areaLabel(areaOf(c));
      byArea.set(k, (byArea.get(k) ?? 0) + 1);
    }
    for (const [area, count] of [...byArea].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))) {
      const s = document.createElement("span");
      s.textContent = `${area} ${count}`;
      areas.appendChild(s);
    }
    let day = "";
    for (const r of collapse(rows)) {
      const d = dayLabel(r.at);
      if (d && d !== day) {
        day = d;
        const h = document.createElement("div");
        h.className = "ml-upd-day";
        h.textContent = d;
        list.appendChild(h);
      }
      const row = document.createElement("div");
      row.className = "ml-upd-row";
      row.dataset.area = r.area;
      const chip = document.createElement("span");
      chip.className = "ml-upd-chip";
      chip.textContent = areaLabel(r.area);
      const body = document.createElement("div");
      body.className = "ml-upd-body";
      const subj = document.createElement("div");
      subj.className = "ml-upd-subj";
      subj.textContent = r.text;
      if (r.count > 1) {
        const x = document.createElement("span");
        x.className = "ml-upd-x";
        x.textContent = ` ×${r.count}`;
        subj.appendChild(x);
      }
      const meta = document.createElement("div");
      meta.className = "ml-upd-meta";
      meta.textContent = `${timeLabel(r.at)} · ${r.sha.slice(0, 9)}`;
      body.append(subj, meta);
      row.append(chip, body);
      list.appendChild(row);
    }
    if (truncated) {
      const note = document.createElement("div");
      note.className = "ml-upd-note";
      note.textContent = "…and earlier changes your build is behind.";
      list.appendChild(note);
    }
    // YOUR OWN BUILD, LAST AND MARKED (maintainer 2026-09-19: "it would also be
    // nice to somehow highlight when I get to the bottom and see the current
    // version. So I get everything new on top of it but I can also read what
    // happened in my version, but it has to be clear this is my version and not
    // part of the commit — so my commit should always be at the bottom and
    // marked"). It is the document's own entry for the sha we are RUNNING, so
    // it says what this build was; it is drawn outside the day groups, after a
    // heavier rule and under its own label, because it is the floor of the
    // list rather than another change in it. Absent from the window (a build
    // older than the 50 the wiki publishes) = no block, never a guess.
    const ownIdx = doc.commits.findIndex((c) => sameSha(c.sha, mine));
    const own = ownIdx >= 0 ? doc.commits[ownIdx] : null;
    if (own) {
      const block = document.createElement("div");
      block.className = "ml-upd-mine";
      const label = document.createElement("div");
      label.className = "ml-upd-youre";
      label.textContent = "You are running";
      const row = document.createElement("div");
      row.className = "ml-upd-row";
      row.dataset.area = areaOf(own);
      const chip = document.createElement("span");
      chip.className = "ml-upd-chip";
      chip.textContent = areaLabel(areaOf(own));
      const body = document.createElement("div");
      body.className = "ml-upd-body";
      const subj = document.createElement("div");
      subj.className = "ml-upd-subj";
      subj.textContent = cleanSubject(own);
      const meta = document.createElement("div");
      meta.className = "ml-upd-meta";
      meta.textContent = `${dayLabel(own.at)} ${timeLabel(own.at)} · ${own.sha.slice(0, 9)}`;
      body.append(subj, meta);
      row.append(chip, body);
      block.append(label, row);
      list.appendChild(block);
    }
  };

  if (notesDone) {
    loading.remove();
    fill(notesReady); // …and only THEN does the card meet the document
    document.body.appendChild(back);
    open = back;
  } else {
    document.body.appendChild(back);
    open = back;
    void prefetchNotes().then((doc) => {
      if (open !== back) return; // closed while it loaded
      loading.remove();
      fill(doc);
    });
  }
  return back;
}

// The probe surface this module owns (the pattern __mlAmbient / __mlSelect /
// __mlMapLayers use), so the gate can open the dialog without a real deploy.
(window as unknown as { __mlUpdateNotes?: unknown }).__mlUpdateNotes = {
  open: openUpdateNotes,
  /** Start (or await) the notes fetch — what main.ts does before the toast. */
  prefetch: prefetchNotes,
  /** QA only: drop the memoised fetch so the next open asks again. The runtime
   *  never does this — the notes are fetched once per page by design. */
  forget: () => {
    notesPromise = null;
    notesReady = null;
    notesDone = false;
  },
  close: closeUpdateNotes,
};
