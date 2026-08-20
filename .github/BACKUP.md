# Off-GitHub backup → Google Cloud Storage

No human keeps a clone — agents are the only ones who touch git — so GitHub is
a single point of failure (account lockout, bad force-push, repo deletion).
These zips are the safety net for when GitHub *isn't* there.

**Workflow:** `.github/workflows/backup-gcs.yml` — **weekly, Mondays 08:17
UTC** (after the art loops' ~02:30 pass so the snapshot catches fresh art;
off-round minute on purpose), or run by hand from the Actions tab. Retention:
the bucket's own 30-day lifecycle rule ≈ 4 snapshots spanning a month.

**Weekly is a law, not a default.** The bucket is **Nearline**, which bills a
**30-day minimum storage duration per object** — so daily-with-a-14-day-purge
was REJECTED (deleting at 14 days still bills 30: fewer restore points, zero
savings), and Standard dodges the minimum at ~2× per GB. Measured on the real
archive in europe-north1: daily/30d ~8.7 GB-months (~0.95 kr/mo); weekly/30d
~1.25 GB-months (~0.14 kr/mo). **Frequency is the only lever on this bill.**
(Archive class also rejected: 365-day minimum → early-deletion charges when
the lifecycle deletes at 30.)

## What's in the zip

`git archive HEAD` — the current state of every **tracked** file, no history.
Measured 2026-08-20: **42,175 tracked files → 53,449 zip entries, ~324 MB
uncompressed, 292 MB zipped.** Deliberately absent:

| Not included | Why |
|---|---|
| `.git/` | ~2.3 GB of history. GitHub is the history; this is the current-state snapshot. |
| `node_modules/` | Gitignored. `npm ci` rebuilds it. |
| **`.env`** | Gitignored — so `PIXELLAB_API_KEY` **cannot** ride along into cloud storage. A plain `tar` of the working tree *would* leak it. |

## Setup (once, from a phone)

Paste ONE line into <https://shell.cloud.google.com>:

```
curl -sS https://raw.githubusercontent.com/mikael-floden/pixel/main/.github/gcs-backup-bootstrap.sh | bash
```

Nothing to set afterwards: **the workflow DERIVES the bucket name**
(`<project-id>-nangijala-backups`, the same name the bootstrap creates). The
`GCS_BACKUP_BUCKET` repo variable is only an override for a bucket somewhere
else; a missing bucket fails the run with that exact paste-this line. (Trap
paid for: the name used to be a hand-set repo variable and the setup said "run
this on your machine" — the maintainer has no machine, so for three nights,
2026-08-15..17, every run expanded to `gs:///`, died on a URL-parse error, and
backed up nothing while looking healthy. Ops steps here must be phone-paste
one-liners, and workflows derive values instead of asking for them.)

**There are no secrets.** The workflow authenticates with the same keyless
Workload Identity Federation the deploy uses — nothing to store, rotate, or
leak. That is why this is a bucket and not personal Drive (REJECTED): Drive
sits outside that trust boundary and needs a long-lived OAuth refresh token in
repo secrets plus a browser consent screen; a service account can't own
consumer-Drive files either (no Drive storage quota), so impersonation is no
way around it.

## Append-only by construction

The bucket lives in the **same GCP project as production**; the permissions
are what stop one compromised pipeline from losing both:

- the deploy SA holds **`objectCreator` + `objectViewer`**, scoped to this
  bucket — write a snapshot, read it back to verify;
- it does **not** hold `objectAdmin`: CI cannot delete or overwrite a backup.
  Not "shouldn't" — *cannot*;
- deletion is the bucket's own **lifecycle rule** (30 days), unreachable from
  CI. Public access prevention on; uniform bucket-level access.

Honest scope of append-only: a compromised pipeline can still *add* junk
snapshots — it cannot destroy one. And retention is age-based, not
keep-newest-N, so 30 straight days without an upload empties the bucket. GitHub emails on every
workflow failure — that failure mode needs a month of ignored emails.

## Restoring

```
gcloud storage ls gs://<bucket>                    # pick a snapshot
gcloud storage cp gs://<bucket>/nangijala-....zip .
unzip nangijala-....zip -d restored && cd restored/games2 && npm ci
```

A complete working tree — the game builds, every art domain is there. No git
history this way; for history, clone from GitHub.

## Verification (a silent bad backup is worse than none)

The workflow refuses to trust its own output at three points:

1. `unzip -t` on the real archive, plus entry (>20,000) and byte (>50 MB)
   floors — a broken checkout or empty tree fails loudly instead of uploading.
2. `gcloud storage cp` validates a CRC32C checksum end to end — a corrupted
   transfer fails the step rather than landing quietly.
3. The object is read back from GCS and size-compared against the local file —
   `cp` exiting 0 is not proof the far end is readable.

## A second copy, if ever wanted

This covers "GitHub is gone", not "the Google account is gone". The cheapest
addition is a copy into a **different** cloud account — never a second bucket
in the same project, which shares the failure it should protect against.
