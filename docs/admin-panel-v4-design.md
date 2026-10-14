# Admin panel v4 — design (VillaST)

Card: t_ad69acd1 · Branch: `feat/admin-panel-v4` · Date: 2026-10-14

## Goal

The host (non-technical, iPhone-first, occasionally desktop) runs the rental from the admin
panel: a push notification on every new request, tapping it opens the installed PWA, and she
accepts or declines in two taps. On accept, the guest receives the confirmation email from the
villa Gmail (`rifugiotavolara.st@gmail.com`). Everything runs on free tiers — no Cloud
Functions, no paid service, no always-on extra hardware.

## Decided with the user (2026-10-14)

- Push to the iPhone instead of host email; email is used only for the guest confirmation.
- Runner: **Google Apps Script** (5-minute time trigger) — reads Firestore with a service
  account, sends FCM HTTP v1 pushes and MailApp emails from the villa Gmail. No Blaze plan.
- Villa Google account `rifugiotavolara.st@gmail.com`: script owner, email sender, site contact.
- Dropped: guest-mailto draft (solution A) and EmailJS.

## Acceptance criteria

- **AC1 — Mobile home = request queue.** At 390 px the post-login default view lists pending
  requests newest-first with name, dates + nights, guests, age, a conflict flag when the request
  overlaps an occupied day, and Accetta/Rifiuta buttons with >=44 px hit targets; accepting a
  conflicting request is refused with a visible reason.
- **AC2 — Calendar + day sheet.** The month grid still paints availability from
  `availability`+reservations (`buildAdminDayState`); the day popup renders as a bottom sheet at
  <=768 px and as a centered card above; occupy / remove-block / pending confirm / pending reject
  / draft-save all still work, no console errors.
- **AC3 — Prenotazioni.** Status filter + free-text search over name/email; the mobile card
  layout keeps its data-labels.
- **AC4 — PWA + notifications (client).** `/admin` serves `manifest.webmanifest`
  (display standalone, start_url+scope `/admin`, 192/512 icons) and registers a service worker
  scoped `/admin`; "Attiva notifiche" in Impostazioni requests permission on a user gesture and
  persists an FCM token to `pushTokens` (admin-only); the panel shows notification state and
  offers "push di prova" (writes a `pushTests` doc; the Apps Script delivers it within <=5 min).
- **AC5 — Rules.** `reservations` read/update/delete, `availability` create/delete,
  `pushTokens` write and `pushTests` create require an `admins/{uid}` doc; guest pending create
  and public availability read are unchanged. `test/rules.test.mjs` runs against the Firestore
  emulator with zero npm dependencies and exits 0.
- **AC6 — Guest form.** Writes `lang` ('it'|'en') and `pushState:'new'` on submit; the site
  footer email is `rifugiotavolara.st@gmail.com`; `node tools/build-en.mjs` and
  `node tools/check-seo.mjs` both exit 0.
- **AC7 — Notifier source.** `tools/apps-script/` carries `notify.gs`, `appsscript.json` and
  `README.md` (deploy checklist): `tick()` polls Firestore with the Script-Properties service
  account, pushes new `pending` requests to every `pushTokens` token (FCM HTTP v1), sends the
  MailApp confirmation for `confirmed` requests in the guest's language, marks
  `pushState`/`mailState`, prunes 404/410 tokens.
- **AC8 — Docs.** `AGENTS.md` + `DEV_NOTES.md` updated (user approved the AGENTS.md edit);
  this design doc committed.
- **AC9 — No regressions.** No console errors and no horizontal scroll on `/`, `/en/`, `/admin`
  at 390/768/1440 px.

## Architecture

### Flow 1 — new request -> push
Guest form (`js/reservations.js`) writes `reservations {source:'guest', status:'pending', lang,
pushState:'new', createdAt}` -> Apps Script `tick()` (every 5 min): query `status=='pending'`,
skip `pushState=='sent'`, send FCM v1 `messages:send` per `pushTokens` token, then PATCH
`pushState='sent'`, `pushSentAt`.
Invariant unchanged: a pending request never occupies dates; only `confirmed`/`blocked` create
`availability` docs.

### Flow 2 — accept -> guest email
Panel "Accetta" -> existing atomic batch (availability claims + `status:'confirmed'`) [unchanged] -> `tick()`: query `status=='confirmed'`, skip `mailState=='sent'`, `MailApp.sendEmail`
in the guest's language, PATCH `mailState='sent'`, `mailSentAt`.

### Flow 3 — install (host, one-off)
Safari -> `/admin` -> login -> Impostazioni -> "Aggiungi a Home" instructions -> open from the
icon -> "Attiva notifiche" (user gesture) -> token stored -> push di prova.

### Files

- NEW `manifest.webmanifest`, `sw.js` (root; scope `/admin`; compat Firebase SDK via
  importScripts; push -> showNotification; notificationclick -> open/focus `/admin`)
- NEW `js/notify-client.js` (subscribe, state, test push)
- NEW `images/icon-192.png`, `images/icon-512.png` (generated from `apple-touch-icon.png`)
- MOD `admin.html` (manifest + apple meta, tabs Richieste/Calendario/Prenotazioni/Impostazioni,
  queue markup, settings panel, install banner)
- MOD `css/admin.css` (bottom tab bar <=768 px, request cards, bottom sheet, direction per pick)
- MOD `js/admin.js` (tabs, queue render + conflict flag, search, settings + notifications,
  sheet class, uid display)
- MOD `js/reservations.js` (+`lang`, +`pushState`)
- MOD `index.html` (footer email) -> `tools/build-en.mjs` -> `tools/check-seo.mjs`
- MOD `firestore.rules` (`isAdmin()` = exists(`admins/$(uid)`))
- NEW `test/rules.test.mjs` (raw REST vs emulator, no deps)
- NEW `tools/apps-script/{notify.gs,appsscript.json,README.md}`
- MOD `AGENTS.md`, `DEV_NOTES.md`; NEW `docs/admin-panel-v4-design.md` (this file)

### Notification payload
Title `Nuova richiesta — Rifugio Tavolara`; body `<nome> · <checkIn>–<checkOut> · <n> ospiti`;
`webpush.fcm_options.link` -> `https://villa-serenita-san-teodoro.web.app/admin`.

## Verification plan

1. `test/rules.test.mjs` under `firebase emulators:exec` -> output goes into the evidence note.
2. Local static serve + Chromium: `/`, `/en/`, `/admin` at 390/768/1440 px; console error count,
   horizontal-scroll check, screenshots listed in the evidence.
3. Syntax: `node --input-type=module --check` on changed modules; `build-en` + `check-seo`.
4. Mockups shown to the user before the UI build; direction picked by the user.
5. End-to-end push/email: needs the manual setup below; verified on the real iPhone. Not claimed
   before that.

## Manual setup checklist (one-off; browser OAuth on the villa account — the agent cannot do it)

1. Firebase console -> enable Cloud Messaging API; Settings -> Cloud Messaging -> Web Push
   certificates -> generate key pair; copy the **public** key into `js/notify-client.js`.
2. Project settings -> Service accounts -> generate new private key (JSON).
3. Apps Script on `rifugiotavolara.st@gmail.com`: paste `notify.gs` + `appsscript.json`;
   Script Properties `FIREBASE_SA` (full JSON) and `PROJECT_ID`; time trigger `tick` every
   5 minutes; authorize.
4. Firestore -> create doc `admins/{hostUid}` (uid shown in Impostazioni).
5. iPhone: Safari -> `/admin` -> login -> Add to Home Screen -> open icon -> Attiva notifiche ->
   push di prova.
6. Deploy: `npx firebase-tools deploy --only firestore:rules,hosting` (or CI on merge to main).

## Out of scope

- Rejection email to guests (only confirmation).
- Payments / prices / revenue (no price data in the model).
- Multi-user/roles; admin i18n (Italian only).
- Public-site changes beyond the contact email and the two new reservation fields.

## Known ceilings (stated)

- Apps Script time triggers fire "approximately": budget <=5-6 min notification latency.
- Consumer quotas: 90 min/day trigger runtime (~10 min used), 100 email recipients/day (<5 used),
  20k URL fetches/day.
- Permission denied or iOS <16.4 or no Home-Screen install -> no push; the panel queue still works.
