# VillaST — San Teodoro, Sardegna 🌊

Sito web per villa vacanze con sistema di prenotazioni integrato.  
Static site with Firebase Firestore backend, hosted on Firebase Hosting.

## Stack

- HTML5 + CSS3 + Vanilla JS (no build step)
- Firebase Firestore + Authentication (v10.12.0 CDN)
- AOS 2.3.4 + Flatpickr (CDN)
- GitHub Actions → Firebase Hosting (auto-deploy on push to `main`)

## CI/CD Setup

1. Firebase Console → Project Settings → Service Accounts → Generate new private key
2. GitHub repo → Settings → Secrets → Actions → New secret:
   - Name: `FIREBASE_SERVICE_ACCOUNT_VILLA_SERENITA_SAN_TEODORO`
   - Value: the downloaded JSON content
3. Push to `main` → workflow deploys automatically

## Firestore Rules

Deploy with:
```bash
npx -y firebase-tools@latest deploy --only firestore:rules --project villa-serenita-san-teodoro
```

## Local Development

```bash
npx live-server .
# or: python -m http.server 8000
```
