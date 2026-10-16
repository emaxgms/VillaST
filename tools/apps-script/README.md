# VillaST notifier (Google Apps Script)

One file, hosted free on Google's servers, owned by **rifugiotavolara.st@gmail.com**.
Every 5 minutes it pushes new booking requests to the host's iPhone (FCM web push),
emails the guest the confirmation when the host accepts and a polite decline when
the host rejects the request — all from the villa Gmail.

Source of truth: `notify.gs` (this directory). The live copy runs in the villa
Google account — this repo file is the versioned source you paste/clasp-push.

## One-off setup (browser, ~10 minutes)

1. **Firebase console → Cloud Messaging.** Project settings → Cloud Messaging →
   enable the Cloud Messaging API; then *Web Push certificates* → **Generate key
   pair** → copy the **public** key (starts with `B...`) into
   `js/notify-client.js` → `VAPID_PUBLIC_KEY`.
2. **Service account.** Project settings → Service accounts → *Generate new
   private key* → JSON downloaded. This is the credential the script uses to
   read Firestore and send FCM; it never goes into the repo.
3. **Apps Script.** In the villa Google account open <https://script.google.com>
   → New project → name it `VillaST notifier` → paste `notify.gs` into
   `Code.gs` → Project Settings → check *Show "appsscript.json"* → paste
   `appsscript.json`.
4. **Script Properties** (Project Settings → Script properties):
   - `FIREBASE_SA` = the whole JSON from step 2 (paste it in one block)
   - `PROJECT_ID` = `villa-serenita-san-teodoro` (informational; the file already
     carries it as a constant)
5. **Authorize + trigger.** In the editor run `installTrigger` once and accept
   the permission prompt (send mail, external requests, triggers). Then run
   `checkSetup` — it prints the token count, the pending/mail backlog and the
   remaining mail quota.
6. **admins doc.** Firestore → create the document `admins/<hostUid>` (the uid
   is shown in the panel under *Impostazioni → UID admin*). Without it the host
   can log in but Firestore will refuse every read.
7. **iPhone.** Open `/admin` in Safari → log in → Share → *Add to Home Screen*
   → open the icon → *Impostazioni → Attiva notifiche* → allow. Then tap
   *Invia push di prova*: the push arrives within one tick (≤5 min).

## Operational notes

- Quotas (consumer Google account): 90 min/day trigger runtime (this uses
  ~5-10), 20 000 UrlFetch/day, 100 mail recipients/day (<5 used). If a quota is
  exceeded the run throws and the next tick retries.
- Time-driven triggers fire *approximately* on schedule — budget ≤5-6 min of
  latency. `TICK_MINUTES` accepts 1, 5, 10, 15 or 30 (Apps Script restriction);
  1 minute roughly triples the trigger-runtime budget.
- Dead push tokens (Apple/Mozilla answers 404/410) are deleted automatically.
- Idempotency: every send is marked on the reservation (`pushState`/`mailState`)
  before the next tick, so a retry cannot double-send.
- Rejection email: armed by `rejectMailState:'new'` (written by the admin panel
  together with `status:'rejected'`); sent once in the guest's language, then
  marked `'sent'` + `rejectMailSentAt`. Reservations rejected before this field
  existed (no `rejectMailState`) are never mailed retroactively.
- The script bypasses Firestore rules (service-account auth): that is what lets
  the rules stay closed to `admins/{uid}` only.

## Deploy flow

Edit `notify.gs` here → copy into the Apps Script editor (or `clasp push` if you
set up clasp) → run `checkSetup` to confirm it still authenticates.
