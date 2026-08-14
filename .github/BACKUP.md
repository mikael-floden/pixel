# Off-GitHub backup → Google Cloud Storage

Nobody on this project keeps a local clone — the agents are the only ones who
touch git. That makes GitHub a single point of failure: an account lockout, a
bad force-push, or a repo deletion takes everything.

**Workflow:** `.github/workflows/backup-gcs.yml` — daily 08:17 UTC, or run it
by hand from the Actions tab.
**Setup:** `.github/gcs-backup-bootstrap.sh`, once.

## What's in the zip

`git archive HEAD` — the current state of every **tracked** file, no history.
Measured 2026-08-14: **42,920 entries, ~325 MB uncompressed, 274 MB zipped.**

Deliberately absent, and each for a reason:

| Not included | Why |
|---|---|
| `.git/` | 2.3 GB of history. GitHub is the history; this is the *current state* snapshot that was asked for. |
| `node_modules/` | Gitignored. `npm ci` rebuilds it. |
| **`.env`** | Gitignored — so `PIXELLAB_API_KEY` **cannot** ride along into cloud storage. A plain `tar` of the working tree *would* have leaked it. |

## Setup

```
PROJECT_ID=your-gcp-project ./.github/gcs-backup-bootstrap.sh
```

Then set the one repo variable it prints (Settings → Secrets and variables →
Actions → **Variables**):

| Kind | Name | Value |
|---|---|---|
| Variable | `GCS_BACKUP_BUCKET` | `<project-id>-nangijala-backups` |

**There are no secrets.** The workflow authenticates with the same keyless
Workload Identity Federation the deploy already uses, so there is nothing to
store, rotate, or leak. That is the whole reason this is a bucket and not
personal Drive: Drive sits outside that trust boundary and would have needed a
long-lived OAuth refresh token in repo secrets, plus a browser consent screen
to mint it. (A service account can't own consumer-Drive files either — service
accounts have no Drive storage quota — so impersonation isn't a way around it.)

## The append-only design

The obvious objection to a bucket is that it lives in the **same GCP project as
production**, so one compromised pipeline could take both. That is answered
directly by the permissions:

- the deploy SA gets **`objectCreator` + `objectViewer`**, scoped to this
  bucket — write a new snapshot, read one back to verify;
- it does **not** get `objectAdmin`. CI cannot delete or overwrite an existing
  backup. Not "shouldn't" — *cannot*;
- retention is the bucket's own **lifecycle rule** (30 days), which nothing in
  CI can reach.

So a compromised deploy pipeline can add junk to the bucket. It cannot destroy
the history. Public access prevention is on, and access is uniform
bucket-level.

The honest cost of append-only: since CI can't prune, deletion is age-based
rather than keep-newest-N. If backups stopped uploading for 30 straight days,
the last one would age out and the bucket would empty. GitHub emails on
workflow failure, so that needs a month of ignored failures — accepted in
exchange for backups CI can't wipe.

## Cost

30 daily snapshots × 274 MB ≈ **8.2 GB**, Nearline, one region:

**≈ 0.8 kr/month.** Against the ~350 kr/month the project already spends, this
is free in practice.

Nearline (not Archive) is deliberate: Archive is cheaper per GB but has a
**365-day minimum storage duration**, so deleting at 30 days would bill an
early-deletion charge for the other 335. Nearline's 30-day minimum exactly
matches the lifecycle, so nothing is ever deleted early.

## Restoring

```
gcloud storage ls gs://<bucket>                    # pick a snapshot
gcloud storage cp gs://<bucket>/nangijala-....zip .
unzip nangijala-....zip -d restored && cd restored/games2 && npm ci
```

That's a complete working tree — the game builds and every art domain is
there. You get no git history this way; if that's what you need, clone from
GitHub. These zips are the safety net for when GitHub *isn't* there.

## Verification, because a silent bad backup is worse than none

The workflow refuses to trust its own output at three points:

1. `unzip -t` on the real archive, plus entry (>20,000) and byte (>50 MB)
   floors — a broken checkout or empty tree fails loudly instead of uploading.
2. `gcloud storage cp` validates a CRC32C checksum end to end, so a corrupted
   transfer fails the step rather than landing quietly.
3. The object is read back from GCS and size-compared against the local file —
   `cp` exiting 0 is not proof the object is readable at the far end.

## A second copy, if you want one

This covers "GitHub is gone". It does not cover "the Google account is gone".
If that matters, the cheapest addition is a copy into a **different** cloud
account — not a second bucket in the same project, which shares the failure it
is meant to protect against.
