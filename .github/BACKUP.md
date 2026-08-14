# Off-GitHub backup → Google Drive

Nobody on this project keeps a local clone — the agents are the only ones who
touch git. That makes GitHub a single point of failure: an account lockout, a
bad force-push, or a repo deletion takes everything. This puts a nightly zip
somewhere with a **different blast radius**: a Drive folder the maintainer owns
personally, outside both GitHub and the GCP project.

**Folder:** [nangijala-backups](https://drive.google.com/drive/folders/1BQH6i16t0rpRN0BEq74RQisI5yd1sFSg)
**Workflow:** `.github/workflows/backup-gdrive.yml` — daily 08:17 UTC, or run
it by hand from the Actions tab.

## What's in the zip

`git archive HEAD` — the current state of every **tracked** file, no history.
Measured 2026-08-14: **42,920 entries, ~325 MB uncompressed, 274 MB zipped.**

Deliberately absent, and each for a reason:

| Not included | Why |
|---|---|
| `.git/` | 2.3 GB of history. GitHub is the history; this is the *current state* snapshot the maintainer asked for. |
| `node_modules/` | Gitignored. `npm ci` rebuilds it. |
| **`.env`** | Gitignored — so `PIXELLAB_API_KEY` **cannot** ride along into cloud storage. A plain `tar` of the working tree *would* have leaked it. |

## One-time setup

Three secrets and one variable, in **Settings → Secrets and variables → Actions**.

The variable is already known:

| Kind | Name | Value |
|---|---|---|
| Variable | `GDRIVE_FOLDER_ID` | `1BQH6i16t0rpRN0BEq74RQisI5yd1sFSg` |

The secrets come from one `rclone` login. **This step needs a computer with a
browser** — it's a Google OAuth consent screen, so it can't be done from a
phone or from CI.

1. Install rclone locally: <https://rclone.org/install/>
2. Run `rclone config` and answer:
   - `n` (new remote), name it **`gd`**
   - storage: **`drive`**
   - `client_id` / `client_secret`: **press Enter to leave blank** to start.
     (rclone then uses its shared OAuth app, which is rate-limited but fine for
     one upload a night. If uploads ever get throttled, make your own OAuth
     client in the GCP console and fill these in — that's the only reason to.)
   - scope: **`1`** (full access — needed because the workflow also *deletes*
     old backups, and because the folder above was created by another app)
   - root folder / service account: leave blank
   - `y` for auto config → a browser opens → approve
   - `n` to team drive, then `y` to confirm, `q` to quit
3. Print the credentials:
   ```
   rclone config show gd
   ```
4. Copy each value into a GitHub **secret**:

   | Secret | From `rclone config show gd` |
   |---|---|
   | `GDRIVE_CLIENT_ID` | `client_id` (leave the secret unset if you left it blank) |
   | `GDRIVE_CLIENT_SECRET` | `client_secret` (same) |
   | `GDRIVE_TOKEN` | the whole `token = {...}` JSON blob, braces included |

5. Actions tab → **backup to gdrive** → **Run workflow**. It prints what it
   uploaded and everything currently in the folder.

## Retention and quota

Keeps the newest **14** (override with the `keep` input on a manual run).
14 × 274 MB ≈ **3.8 GB** against Google's free 15 GB.

Pruning deletes **permanently**, not to Trash — Drive's Trash keeps counting
against quota for 30 days, so trashing would free nothing for a month.

## Restoring

Download the newest zip, unzip, and:

```
cd games2 && npm ci
```

That's a complete working tree — the game builds and the art domains are all
there. You get no git history this way; if that's what you need, clone from
GitHub instead. These zips are the safety net for when GitHub *isn't* there.

## Why not just upload from a chat session

The Claude Drive connector's only upload path is inline content — the bytes
have to pass through the model's context. Base64 of a 274 MB zip is ~382 MB of
text, about **477× a full context window**. And a backup has to run unattended
at 08:17 UTC, which a chat session by definition doesn't. rclone streams runner
→ Drive directly and needs nobody present.

## Alternative worth knowing about

A Google Cloud Storage bucket would need **zero new credentials** — the deploy
workflow already authenticates to GCP keylessly via Workload Identity
Federation, so it'd just be a new permission on the existing service account.
At Archive-class pricing 3.8 GB costs well under 1 kr/month.

It is deliberately **not** what we did: GCS lives in the same Google Cloud
project as production, so a billing suspension or a compromised project takes
the backups with it. Drive is a separate blast radius, which is the entire
point. Worth adding as a *second* copy, not as a replacement.
