# account/docs — costs and payments

The measurements and the decided-in-advance payment model behind
`account/README.md`. The README holds the law; this holds the receipt.

## Firestore, measured 2026-09-07

us-central1 rates (EU somewhat higher): reads $0.03/100k, writes $0.09/100k,
deletes $0.01/100k, storage ~$0.144/GiB/month. Free every day: 50,000 reads /
20,000 writes / 20,000 deletes / 1 GiB stored — **for the `(default)` database
only, one per project** (this project had never used Firebase, so the
allowance was unclaimed). No instance, node or minimum: idle is unbilled, and
development runs at ~0.1% of the free tier. PITR and scheduled backups stay
OFF — they bill per GiB and development data is disposable under the
no-migration law.

Write on meaning, not on a timer (README law 2), estimated at 20,000
concurrent players: ~$390/month event-driven vs ~$1,550/month on a 30 s
timer. Write amplification is the cost driver in every database, so the rule
is engine-independent.

The one dependency, measured: `@google-cloud/firestore` pulls 73 packages /
~15 MB of node_modules and costs 89 ms of import at cold start, server-side
only. A zero-dependency alternative (Firestore's REST API + a metadata-server
token, ~50 lines) was rejected: this sits on the critical path of every join,
and a hand-rolled auth refresh and retry would not be rock solid. Google's
client is.

## Payments — decided in advance, built last

- **Platform tax is the strategic fact.** iOS/Android require their IAP for
  in-app digital goods (30%, or 15% under their small-business programmes,
  which this qualifies for); Steam takes 30%. The web keeps ~97%. **The
  browser is the storefront and the apps are clients** — which is what the
  mission already says the game is.
- **One account across every platform**, which only works because of law 1.
- **GDPR**: EU players and an EU maintainer. Storing an email means holding
  personal data — export and delete paths, EU region, and a privacy policy
  (required before any app store accepts a submission anyway). One
  `accountId` reaching all of a player's data makes it trivial. Prefer a
  provider's opaque subject id over storing their email at all — which is
  what `attach.ts` does.
