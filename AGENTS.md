# VillaST

## What this is

Static website for a vacation rental (Rifugio Tavolara) in San Teodoro, Sardinia: marketing page
plus an integrated booking system with an admin dashboard. **No build step** — HTML5 + CSS3 +
vanilla JS ES modules loaded from CDN, with Firebase (Firestore + Auth) as the only backend.

- Bilingual IT/EN (language toggle), bookings + availability calendar + admin panel.
- Firebase Hosting; GitHub Actions auto-deploys on push to `main`.
- Firebase project: `villa-serenita-san-teodoro`.

## Layout

- `index.html` — public landing page (bilingual).
- `admin.html` — admin dashboard (login, reservations, calendar).
- `css/` — `style.css`, `admin.css`, `admin-popup.css`, `calendar.css`.
- `js/` — `firebase-config.js` (init/exports `db`+`auth`), `app.js` (toggle/nav/AOS),
  `reservations.js` (booking form → Firestore), `calendar.js` (Flatpickr availability),
  `admin.js` (auth, reservation CRUD, calendar management), `day-state.js`.
- `firestore.rules` + `firestore.indexes.json` — the only server-side layer.
- `DEV_NOTES.md` — developer guide (read it before structural changes).
- `task/` — payload JSON fixtures; `images/` — assets.

## How to verify (real commands)

```bash
# deploy the site (Actions does this on push to main)
firebase deploy --only hosting

# rules/indexes changes are a SEPARATE deploy
firebase deploy --only firestore:rules
firebase deploy --only firestore:indexes
```

There is no test suite and no linter: verification means loading the deployed site and exercising
the flow you touched (booking form, admin login, calendar), plus checking the browser console.

## Conventions and gotchas

- **No Cloud Functions**: Firestore security rules are the entire server-side enforcement — never
  rely on client-side checks for an invariant (double bookings, restricted writes).
- **Every user-facing string exists twice** (IT and EN): adding a string in one language only is a bug.
- Edits go through a **branch + PR** (never push directly to `main`); the PR gets a Firebase preview.
- `serviceAccountKey.json` and `.env`-style files must never be committed.
- Google masks API keys in API responses (`AIza...xx`) — the web SDK still works on Hosting; don't
  "fix" a masked key.
- Keep `firestore.rules` in sync with what the JS actually writes; a rule change needs its own deploy.
