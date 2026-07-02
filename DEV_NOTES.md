# DEV_NOTES.md — VillaST Developer Guide

## Project Overview

VillaST is a static website for a vacation rental villa in San Teodoro, Sardinia. It uses Firebase for backend services (Firestore, Authentication) and is deployed via Firebase Hosting.

**No build step required** — the site uses vanilla JS with ES modules loaded directly from CDN.

## Project Layout

```
├── index.html              Main landing page (bilingual IT/EN)
├── admin.html              Admin dashboard (login, reservations, calendar)
│
├── css/
│   ├── style.css           Main site styles (responsive, AOS animations)
│   └── admin.css           Admin panel styles
│
├── js/
│   ├── firebase-config.js  Firebase app initialization (API keys, exports db/auth)
│   ├── app.js              Main app logic (language toggle, navbar, AOS init)
│   ├── reservations.js     Booking form submission to Firestore
│   ├── calendar.js         Flatpickr calendar for availability display
│   └── admin.js            Admin dashboard (auth, reservation CRUD, calendar mgmt)
│
├── images/                 Image assets (.gitkeep placeholder)
│
├── firestore.rules         Firestore security rules
├── firestore.indexes.json  Firestore composite indexes (empty)
├── firebase.json           Firebase hosting config (headers, rewrites, auth)
├── .firebaserc             Firebase project alias (villa-serenita-san-teodoro)
└── package.json            Empty — no npm deps needed
```

## How to Add a New Public Page

1. Create a new `.html` file in the root (e.g., `policies.html`).
2. Copy the `<head>` and nav structure from `index.html`.
3. Add a nav link in `index.html` → `<div class="nav-links">` and the mobile menu.
4. Test locally with `python3 -m http.server 8000`.

## How to Add a Firestore Collection

1. Define the collection schema (fields, types).
2. Add security rules in `firestore.rules`:
   ```
   match /my-collection/{doc} {
     allow read: if true;              // public read
     allow write: if request.auth != null && request.auth.token.admin == true;
   }
   ```
3. Deploy rules: `firebase deploy --only firestore:rules`
4. Add client-side code in `js/` to read/write the collection.

## Firebase Authentication

- Email/password and Google Sign-In are enabled.
- Admin access requires a custom claim `admin: true` on the Firebase Auth user.
- Set admin claim via Firebase Admin SDK (see Firebase docs).

## Deploying

```bash
# Full deploy (hosting + firestore rules)
firebase deploy

# Hosting only
firebase deploy --only hosting

# Firestore rules only
firebase deploy --only firestore:rules
```

## Key Files Reference

| File | Purpose |
|------|---------|
| `firebase-config.js` | Firebase app config, exports `app`, `db`, `auth` |
| `firestore.rules` | Security rules for all collections |
| `firebase.json` | Hosting config (CSP headers, rewrites, auth providers) |
| `.firebaserc` | Project ID (`villa-serenita-san-teodoro`) |

## Notes

- The site is bilingual (IT/EN) — use `<span class="it">` and `<span class="en">` for text.
- Gallery images are from Unsplash (external URLs) — no local image optimization needed.
- Flatpickr is used for date selection in booking forms and admin calendar.
- AOS (Animate On Scroll) is used for scroll animations.
