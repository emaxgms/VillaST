# VillaST — vision, roadmap and status

**One line**: the villa's entire rental front office — a bilingual site that converts, a
phone-first panel the host runs from her iPhone, and a free-tier notifier that pushes and mails —
with no paid infrastructure and no server to babysit.

## Who it serves

- **The guest** — arrives from search or Booking.com, checks live availability, sends a request in
  under a minute. No account, no payment on the site.
- **The host** (non-technical, iPhone-first) — one push per request, accept or decline in two taps;
  the guest's confirmation email goes out by itself from the villa Gmail.
- **The owner/developer** — keeps it on free tiers with a small, boring stack.

## Principles (decided, not relitigated)

1. **Free tiers only** — Hosting + Firestore + Auth + FCM, and an Apps Script notifier. No Cloud
   Functions, no Blaze plan, no always-on hardware.
2. **The browser never sends email** — the notifier owns delivery; the panel only records intent
   (`status: 'confirmed'`), the tick does the rest.
3. **Security rules are the only server-side enforcement** — client-side checks are UX, never
   security: guest creates stay `pending`, admin access = an `admins/{uid}` document.
4. **Phone-first admin** — the panel opens on the request queue, two-tap accept, installable PWA.
5. **One display path per notification** — pushes render from the FCM payload; the service worker
   never re-displays (doing both showed every push twice).
6. **The public site is unaffected by admin work** — the service worker is push-only, caches nothing.

## Roadmap and current state (2026-10-15)

| Phase | Scope | State |
|---|---|---|
| 0 — Site + SEO | bilingual URLs, metadata, structured data, sitemap, visual refresh, conversion bar | done (#22, #27) |
| 1 — Admin v4 | phone-first queue, calendar + day sheet, reservations, settings; PWA push; admin-only rules; Apps Script notifier; branded bilingual confirmation email | done (#28–#33) |
| 2 — Go-live polish | host account + `admins/{uid}`, real contacts, legal pages, iPhone install, single-push retest | owner actions, see below |
| 3 — Growth & analytics | Search Console, Google Business Profile, analytics events, custom domain | planned — step-by-step guide in `docs/analytics-fase-5.md` |
| 4 — Open | payments/prices, rejection email, multi-user roles, admin localisation | deliberately out of scope for now |

## Analytics and measurement

Nothing is tagged today, so no user numbers exist yet. The plan (events and why) is in
`docs/seo-marketing-review.md` → *Measurement plan*. Short version:

- the only conversion that matters: `booking_request_submitted`;
- contact intent: `whatsapp_click`, `email_click`, `phone_click`;
- funnel: `calendar_opened`, `dates_selected`; engagement: `gallery_open`;
- monthly review of Search Console impressions/clicks per query (the only real keyword data).
- Tool: GA4 (free, familiar) or Plausible (privacy-first, paid) — **decision still open**.

## Live configuration

| Piece | Value |
|---|---|
| Site (public) | https://villa-serenita-san-teodoro.web.app — `/` IT, `/en/` EN |
| Admin PWA | same origin + `/admin` |
| Firebase project | `villa-serenita-san-teodoro` |
| Notifier | Apps Script owned by `rifugiotavolara.st@gmail.com`, 5-minute trigger |
| CI/CD | GitHub Actions: PR preview channel, deploy on `main` |
| Full technical detail | `README.md` |

## Owner actions (the blocking ones first)

1. **Real contacts** — replace the `OWNER:` placeholders (WhatsApp `393000000000` and the leftover
   `info@rifugiotavolara.it` in `index.html`), then re-run `tools/build-en.mjs` + `tools/check-seo.mjs`.
2. **Host access** — create her Firebase Auth user, create `admins/{herUid}` (console), install the
   PWA on her iPhone, tap *Attiva notifiche*, send one test push.
3. **Re-paste `tools/apps-script/notify.gs`** in the Apps Script editor (new email text + push icon/tag).
4. **Legal** — privacy + cookie pages: the form collects name, email, phone.
5. **Growth** — Search Console + sitemap, Google Business Profile, analytics decision, custom domain.

## Where the details live

- Stack, setup, data model, features — `README.md`
- Developer guide (build, gates, flows) — `DEV_NOTES.md`
- Admin v4 design: goals, flows, setup checklist, ceilings — `docs/admin-panel-v4-design.md`
- SEO/marketing audit, keyword plan, measurement plan, debt — `docs/seo-marketing-review.md`
- Analytics setup guide (GA4 + Search Console, step by step) — `docs/analytics-fase-5.md`
- Agent conventions — `AGENTS.md`
