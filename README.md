# VillaST — San Teodoro, Sardegna 🌊

Sito web per villa vacanze con sistema di prenotazioni integrato.
Static site with Firebase Firestore backend, hosted on Firebase Hosting.

## About the property

Rifugio Tavolara is a 2-bedroom apartment (sleeps 4) in the centre of San Teodoro, Sardinia. It features a private garden with outdoor furniture, a patio, a terrace, free private parking, air conditioning, and a kitchen equipped with a fridge, coffee machine, and kitchenware. Licensed as a short-term rental under CIN **IT090092C2000S4969**. The site is bilingual Italian/English and includes an integrated booking/reservation system with a Firebase backend.

## Stack

- HTML5 + CSS3 + Vanilla JS (no build step)
- Firebase Firestore + Authentication (v10.12.0 CDN)
- AOS 2.3.4 + Flatpickr (CDN)
- GitHub Actions → Firebase Hosting (auto-deploy on push to `main`)

## Project Structure

```
├── index.html          # Main landing page (Italian/English)
├── admin.html          # Admin dashboard (login, reservations, calendar)
├── css/
│   ├── style.css       # Main styles
│   └── admin.css       # Admin panel styles
├── js/
│   ├── firebase-config.js  # Firebase configuration
│   ├── app.js              # Main app logic
│   ├── reservations.js     # Booking form handler
│   ├── calendar.js         # Availability calendar
│   └── admin.js            # Admin dashboard logic
├── images/             # Image assets
├── firestore.rules     # Firestore security rules
└── firebase.json       # Firebase hosting + auth config
```

## Local Development

### Option 1: Firebase Emulators (recommended)

```bash
# Install Firebase CLI
npm install -g firebase-tools

# Login to Firebase
firebase login

# Start emulators
firebase emulators:start
```

### Option 2: Static server (no Firebase features)

```bash
python3 -m http.server 8000
# or
npx live-server .
```

## CI/CD Setup

1. Firebase Console → Project Settings → Service Accounts → Generate new private key
2. GitHub repo → Settings → Secrets → Actions → New secret:
   - Name: `FIREBASE_SERVICE_ACCOUNT_VILLA_SERENITA_SAN_TEODORO`
   - Value: the downloaded JSON content
3. Push to `main` → workflow deploys automatically

## Content source of truth

The canonical property listing is on booking.com: https://www.booking.com/hotel/it/rifugio-tavolara.it.html
The marketing copy in `index.html` is the authoritative version for this site — it may diverge from the listing for layout/formatting reasons.

## Useful commands

There is no build step. For local work:

```bash
python3 -m http.server 8000          # static preview (no Firebase)
node -c js/*.js                      # syntax-check JS files
```

## Firestore Rules

Deploy with:
```bash
npx -y firebase-tools@latest deploy --only firestore:rules --project villa-serenita-san-teodoro
```
