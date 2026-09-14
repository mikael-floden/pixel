/* WHAT HAS LANDED — the last 50 commits on main, for the Release Notes
 * section (maintainer 2026-09-13: "The release notes is not release notes at
 * all. Its just the last 50 gitsha with commint message and date (just so I as
 * an admin can see more easily what has landed). Also put the agent if you
 * have that data (you might be able to tell from the folder that was
 * changed)").
 *
 * WHY THIS IS A CACHED FILE AND NOT A LIVE READ. The wiki's registry is
 * rebuilt inside the deploy image, and the image HAS NO .git — the
 * .dockerignore allowlist keeps it out, which is the same wall
 * `first_seen.json` hit. So the list is derived where git exists and carried
 * in `wiki/release_notes.json`:
 *
 *   • the DEPLOY writes it into the build context before the image build
 *     (nangijala-deploy.yml, build-deploy — a full checkout, no sparse list),
 *     so the deployed page lists the 50 commits ending at the commit you are
 *     playing. That is the honest meaning of "what has landed";
 *   • a local `node wiki/build.mjs` refreshes it from git and commits it, so
 *     the committed copy is the fallback if that step ever fails;
 *   • inside the image `git log` throws and the file answers instead.
 *
 * Run it directly to refresh the cache: `node wiki/lib/releases.mjs`.
 *
 * SHIPS IN THE IMAGE (wiki/lib does; wiki/tools deliberately does not), so
 * build.mjs can import it there.
 */
import { execSync } from "node:child_process";
import { readdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, resolve, dirname } from "node:path";

export const FORMAT = "pixel-wiki-releases@1";
/** How many commits the page shows. His number. */
export const N_COMMITS = 50;
const CACHE = ["wiki", "release_notes.json"];
/** Field and record separators — a commit subject can hold anything a keyboard
 *  can type, so the format string must not be parsed by newline or by pipe. */
const US = "\x1f";
const RS = "\x1e";

/** The agent roster IS the set of board files (`coordination/<agent>.json`) —
 *  derived, never a list here, so an agent hired tonight is recognised without
 *  this file changing (six were hired on 2026-09-12 alone). */
export function roster(root) {
  try {
    return new Set(readdirSync(join(root, "coordination"))
      .filter((f) => f.endsWith(".json"))
      .map((f) => f.slice(0, -".json".length)));
  } catch { return new Set(); }
}

/** An author string as an agent id, or null. The runners mostly commit as
 *  plain "Claude" (every agent does, so it says nothing); some set their own
 *  name — "item-assistant", "games agent" — and that one is exact. */
export function agentFromAuthor(author, known) {
  const a = String(author ?? "").trim().toLowerCase().replace(/\s+agent$/, "").replace(/\s+/g, "-");
  if (!a || a === "claude") return null;
  return known.has(a) ? a : null;
}

/** WHO PUSHED THIS, in order of how much the signal is worth.
 *
 *  1. THE BOARD FILE. One writer per board file, so a commit touching exactly
 *     one `coordination/<agent>.json` was written by that agent — the only
 *     signal here that cannot be wrong.
 *  2. THE AUTHOR, when the runner set a real one (see agentFromAuthor).
 *  3. THE SUBJECT's leading token when it names a known agent: "wiki: …",
 *     "board: games reads …", "tiles-assistant: …". A token that is not on the
 *     roster ("Deploy:", "Settings:", "coordination:") is not an agent and is
 *     ignored rather than guessed at.
 *
 *  There is deliberately NO fallback to the directory. `games2/` alone is
 *  worked by ten agents, so a folder names the DOMAIN and never the agent —
 *  the page shows `dirs` for those, which is what he asked for and is true.
 */
export function agentOf({ author, subject, files }, known) {
  const boards = (files ?? [])
    .map((f) => /^coordination\/([A-Za-z0-9._-]+)\.json$/.exec(f)?.[1])
    .filter(Boolean);
  if (new Set(boards).size === 1 && known.has(boards[0])) return boards[0];
  const byAuthor = agentFromAuthor(author, known);
  if (byAuthor) return byAuthor;
  const tok = /^(?:board:\s*)?([A-Za-z0-9][A-Za-z0-9-]*)\s*:/.exec(String(subject ?? ""))?.[1]?.toLowerCase();
  return tok && known.has(tok) ? tok : null;
}

/** The top-level directories a commit touched, in the order git listed them.
 *  A file at the repo root reports as "" and the page names it "Repo". */
export function dirsOf(files) {
  const out = [];
  for (const f of files) {
    const d = f.includes("/") ? f.slice(0, f.indexOf("/")) : "";
    if (!out.includes(d)) out.push(d);
  }
  // A board update rides along with plenty of real work; it is bookkeeping,
  // never where the work landed — unless it is the whole commit.
  const real = out.filter((d) => d !== "coordination");
  return real.length ? real : out;
}

/** The commits, straight from git. Null when there is no git to ask (the
 *  deploy image), which is a normal answer here and never an error. */
export function fromGit(root, n = N_COMMITS) {
  let out;
  try {
    out = execSync(`git log -n ${n} --format=${RS}%H${US}%cI${US}%an${US}%s --name-only`,
      { cwd: root, stdio: ["ignore", "pipe", "ignore"], maxBuffer: 256 * 1024 * 1024 }).toString();
  } catch { return null; }
  const known = roster(root);
  const commits = [];
  for (const rec of out.split(RS)) {
    if (!rec.trim()) continue;
    const [head, ...rest] = rec.split("\n");
    const [sha, at, author, subject] = head.split(US);
    if (!sha || !at) continue;
    const files = rest.filter((l) => l.trim());
    commits.push({
      sha: sha.slice(0, 9),
      at,
      author,
      subject,
      agent: agentOf({ author, subject, files }, known),
      // The paths themselves are not carried: one art sync touches thousands,
      // and the page shows where and how much, never the list.
      dirs: dirsOf(files),
      files: files.length,
    });
  }
  return commits.length ? commits : null;
}

/** The repo's web home, so a sha can be tapped — DERIVED from the remote, not
 *  written down here (the wiki has never held a hardcoded URL for it). Both
 *  remote spellings, ssh and https, reduce to the same page. Null when there
 *  is no remote, and the page then renders the sha as plain text. */
export function repoUrl(root) {
  try {
    const url = execSync("git remote get-url origin",
      { cwd: root, stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
    const m = /github\.com[/:]([^/]+)\/(.+?)(?:\.git)?$/.exec(url);
    return m ? `https://github.com/${m[1]}/${m[2]}` : null;
  } catch { return null; }
}

export function cachePath(root) { return join(root, ...CACHE); }

export function loadCache(root) {
  try {
    const doc = JSON.parse(readFileSync(cachePath(root), "utf8"));
    return Array.isArray(doc?.commits) ? doc : null;
  } catch { return null; }
}

/** The document the page reads: git when git is there, the committed cache
 *  when it is not. `stale` is the honest half — a cached list names the commit
 *  it was built at, and the page says so rather than implying it is live. */
export function releases(root) {
  const commits = fromGit(root, N_COMMITS);
  if (commits) {
    return { format: FORMAT, generated_at: new Date().toISOString(), head: commits[0].sha, repo: repoUrl(root), commits, from: "git" };
  }
  const doc = loadCache(root);
  if (doc) return { ...doc, from: "cache" };
  return { format: FORMAT, generated_at: new Date().toISOString(), head: null, commits: [], from: "none" };
}

/** Refresh the committed cache. A no-op (and a clean exit) where git cannot
 *  answer — this must never be the reason a deploy fails.
 *
 *  A SHALLOW CLONE ANSWERS WITH ONE COMMIT, AND ONE COMMIT IS NOT A LIST. CI
 *  checks out depth 1, so `git log -50` there succeeds and returns a single
 *  row: without this guard the deploy would cheerfully overwrite a good list
 *  of 50 with a list of 1 and ship it. So the cache never SHRINKS below what
 *  it already holds (short of a repo that genuinely has fewer commits than
 *  N_COMMITS), and the refusal is loud rather than silent. */
export function writeCache(root) {
  const doc = releases(root);
  if (doc.from !== "git") return null;
  const have = loadCache(root)?.commits?.length ?? 0;
  if (doc.commits.length < Math.min(N_COMMITS, have)) {
    console.error(`[releases] git answered with ${doc.commits.length} commit(s) and the committed list holds ${have} — `
      + "a shallow clone, so the list stands. Deepen the history (blobless) before asking.");
    return null;
  }
  const { from, ...body } = doc;
  writeFileSync(cachePath(root), `${JSON.stringify(body, null, 1)}\n`);
  return body;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  const root = process.argv[2] ? resolve(process.argv[2]) : resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
  if (!existsSync(join(root, "coordination"))) {
    console.error(`[releases] ${root} does not look like the repo root`);
    process.exit(1);
  }
  const doc = writeCache(root);
  console.log(doc
    ? `[releases] ${doc.commits.length} commits, head ${doc.head} → ${cachePath(root)}`
    : "[releases] no git here — the committed list stands");
}
