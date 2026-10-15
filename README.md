# VillaST — Rifugio Tavolara, San Teodoro (Sardinia)

Bilingual (IT/EN) marketing site, booking funnel and phone-first admin panel for a short-term
rental — running entirely on **free tiers**: Firebase Hosting + Firestore + Authentication + FCM web
push, and a Google Apps Script notifier for push fan-out and the guest confirmation email.
No Cloud Functions, no Blaze plan, no server of ours.

## Features

**Public site** — `/` (Italian) · `/en/` (English, generated)
- Landing page: gallery with lightbox, amenities, reviews, contact, sticky booking bar.
- Availability calendar (Flatpickr) driven by the `availability` index: only free dates are pickable.
- Booking request form → creates a `reservations` document as `pending` and holds the dates with
  `availability` claims. The guest picks the language (`lang`) at write time.
- SEO: canonical + hreflang, Open Graph/Twitter cards, `VacationRental` JSON-LD, `sitemap.xml`,
  `robots.txt` (admin excluded). Gate: `tools/check-seo.mjs`.

**Admin panel** — `/admin` (`noindex`, installable PWA)
- Login with Firebase Auth; **authorization = an `admins/{uid}` document** (rules-enforced). The uid
  is displayed under *Impostazioni → Account* so the document can be created once from the console.
- *Richieste*: the incoming queue — guest, dates, nights, contact, message, new/conflict badge.
  Accept or decline in two taps; accept is an atomic batch (`status: 'confirmed'` + availability
  claims). Conflicts name the conflicting booking and disable accept.
- *Calendario*: month view; tap a day → sheet with day state; manual occupancy/block editing.
- *Prenotazioni*: full list, status filter, search by name/email; edit and delete.
- *Impostazioni*: notification state (verified against the stored FCM token), "Attiva notifiche",
  test push, PWA install instructions, account + admin uid, sign out.
- Push: one per new request (guest + dates), delivered to every registered device; the service worker
  is **push-only** (`sw.js`, scope `/admin`, caches nothing) so the public site behaves exactly as
  before it.

**Notifier** — `tools/apps-script/notify.gs`, Google Apps Script, 5-minute time trigger
- New request → FCM HTTP v1 push to all `pushTokens`, then `pushState: 'sent'`.
- Accepted → bilingual confirmation email from the villa Gmail (`MailApp`), then
  `mailState: 'sent'`. Skips `source: 'admin'` bookings (manual entries get no email).
- Test pushes requested from the panel (`pushTests`).
- Quotas (consumer account): 90 min/day trigger runtime, 20k UrlFetch/day, 100 mail recipients/day —
  the script uses < 10 min and < 5 e-mails per day. Latency ≤ ~5–6 min by design.

## Runtime configuration

| Piece | Value |
|---|---|
| Firebase project | `villa-serenita-san-teodoro` (`.firebaserc`) |
| Hosting | `https://villa-serenita-san-teodoro.web.app` |
| Firestore | database `(default)`, location `eur3`; rules `firestore.rules`; indexes `firestore.indexes.json` (empty) |
| Auth providers | email/password (the panel); Google Sign-In configured in the project |
| Emulators | Firestore `127.0.0.1:8081`, Auth `9099`, UI off (`firebase.json`, for the rules suite) |
| FCM web push | VAPID **public** key in `js/notify-client.js`; SW `sw.js` (scope `/admin`) |
| Notifier | Apps Script owned by `rifugiotavolara.st@gmail.com`; service-account JSON in Script Properties (`FIREBASE_SA`); trigger `tick()` every 5 min |
| CI/CD | GitHub Actions, secret `FIREBASE_TOKEN`: PR → hosting preview channel `pr-<n>`; push to `main` → `deploy --only hosting,firestore:rules,firestore:indexes` |

`firebase.json` also carries: `cleanUrls`, the `/admin` → `admin.html` rewrite, a CSP + security
headers, `no-cache` for HTML/CSS/JS (images 1 day), and the deploy ignore list (`**/*.md`, `docs/**`,
`tools/**`, `test/**`, `.github/**` — none of them ship to the web).

### Data model (Firestore)

`reservations/{id}` — `name`, `email`, `phone`, `guests`, `checkIn`/`checkOut` (`YYYY-MM-DD`),
`message`, `lang` (`it|en`), `source` (`guest|admin`), `status` (`pending|confirmed|rejected|blocked`),
`createdAt`, and — written by the notifier — `pushState`/`pushSentAt`, `mailState`/`mailSentAt`.

`availability/{YYYY-MM-DD}` — one document per occupied day (`status`, `reservationId`). It is a
**derived index** for fast calendar reads and a second guard against double bookings; the truth is
`reservations` and the accept path writes both in one batch.

`pushTokens/{sha256(token)}` — device tokens (ua, platform, standalone, updatedAt); the notifier
prunes tokens that FCM answers 404/410 for. `pushTests/{id}` — test-push requests. `admins/{uid}` —
admin authorization.

### Security rules (`firestore.rules`, the only server-side layer)

- Guests (unauthenticated) may only **create** a `pending`, `source: 'guest'` reservation with the
  required fields, and read `availability`.
- Everything else (read/update/delete of reservations, `availability` writes, `pushTokens`,
  `pushTests`) requires a document at `admins/{uid}`.
- The notifier runs as a service account, which bypasses rules — that is what lets the rules stay
  closed. Suite: `test/rules.test.mjs` (19 assertions, REST against the emulator).

### Confirmation email

Composed in the notifier, not in the browser: on accept the panel only writes `status: 'confirmed'`;
the next tick picks it up, sends via `MailApp` from the villa Gmail and stamps `mailState: 'sent'`.
The text lives in `mailSubject_()` + `mailHtml_()` and the villa facts (phone, IBAN, address,
check-in 15:00 / check-out 10:00) in the `VILLA_` constants — **replace the OWNER placeholders**.
Full operational notes: `DEV_NOTES.md` → "Host notifications + guest confirmation email".

## One-off setup (new environment)

1. Firebase project + `.firebaserc`; enable Firestore, Authentication (email/password), Hosting.
2. Deploy rules: `firebase deploy --only firestore:rules,firestore:indexes` (CI does it on `main`).
3. Create the host's Auth user; create `admins/{uid}` for every admin (console → Firestore).
4. Cloud Messaging → *Web Push certificates* → generate the key pair; put the **public** key in
   `js/notify-client.js` (`VAPID_PUBLIC_KEY`).
5. Project settings → Service accounts → new private key (JSON).
6. Apps Script (`rifugiotavolara.st@gmail.com`): paste `notify.gs` + `appsscript.json`; Script
   Properties → `FIREBASE_SA` = the JSON from step 5; run `installTrigger()` once; verify with
   `checkSetup()`. Checklist: `tools/apps-script/README.md`.
7. Replace the placeholders in `VILLA_` (phone, IBAN) and re-paste the script; replace the trailer
   contact placeholders in `index.html` (WhatsApp) and re-run `tools/build-en.mjs`.
8. GitHub: add the `FIREBASE_TOKEN` secret for the workflows.

## Repository layout

```
index.html / en/index.html      IT source of truth + generated EN twin
admin.html + manifest.webmanifest + sw.js   Admin PWA (panels, push-only SW)
css/  style.css  calendar.css  admin.css    Public site, calendars, admin "Casa" theme
js/   firebase-config.js app.js reservations.js calendar.js day-state.js admin.js notify-client.js
tools/  build-en.mjs  check-seo.mjs  optimize-images.py  apps-script/{notify.gs,README.md}
test/   rules.test.mjs                      Firestore rules suite (emulator)
docs/   seo-marketing-review.md  admin-panel-v4-design.md  vision.md
firestore.rules  firestore.indexes.json  firebase.json  .firebaserc
```

## Tooling & verification

```bash
node tools/build-en.mjs          # regenerate /en/ after any index.html edit + parity assertions
node tools/check-seo.mjs         # SEO/structural gate, 55 assertions, non-zero on drift
node --input-type=module --check < js/admin.js   # syntax check a module

# Firestore rules suite (emulator; port 8081 — 8080 is taken on the dev host)
npx -y firebase-tools@latest emulators:exec --only firestore --project demo-villast "node test/rules.test.mjs"
```

There is no test framework: the gates above plus a browser pass over the flow you touched. The
developer guide (layout, bilingual build rules, how to add a page or a collection, deploy commands)
is `DEV_NOTES.md`; agent-facing conventions are in `AGENTS.md`. The vision, roadmap and current
status — what we are building and where we are — is `docs/vision.md`.

*Content note: the canonical listing is on Booking.com; the copy in `index.html` is the authoritative
version for this site. Marketing audit and the owner's remaining actions:
`docs/seo-marketing-review.md`.*
