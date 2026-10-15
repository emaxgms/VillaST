# VillaST — Fase analytics: GA4 e Google Search Console (guida operativa)

Guida per chi parte da zero. Spiega **quali servizi servono, cosa fa ciascuno, come sono
collegati** e in che ordine si installano, per la fase analytics della vision di VillaST.

Stato di partenza: **niente è tracciato oggi** («Nothing is tagged today, so no user numbers exist
yet», `docs/vision.md`). Il sito è su `https://villa-serenita-san-teodoro.web.app` (IT `/`, EN
`/en/`), l'admin è su `/admin`.

Questa guida **non crea account e non modifica il sito**: i passi che toccano il codice sono
elencati (passi 2, 3, 6) e vanno eseguiti in un task separato.

---

## 1. Prima cosa: "ag4" è un refuso di GA4

Nel repository non esiste **niente** chiamato `ag4`: `grep -rniE "\bag4\b"` su tutto il progetto
dà zero risultati. Lo strumento analytics citato dalla vision è **GA4 = Google Analytics 4**
(`docs/vision.md`, riga 47: «Tool: GA4 (free, familiar) or Plausible (privacy-first, paid)»;
`docs/seo-marketing-review.md`, riga 122: «Add GA4 (or Plausible)»).

Quindi: **`ag4` = GA4**, versione 4 di Google Analytics. Non è un altro prodotto e non è una sigla
interna al progetto. Nota per non confondersi: il *tag* da installare si chiama ancora `gtag.js`
e l'ID proprietà inizia con `G-`; "GA4" è la proprietà dentro Google Analytics.

---

## 2. A quale fase della vision corrisponde (e una discrepanza da sapere)

`docs/vision.md` **non contiene nessuna sezione numerata "5"**. La roadmap (righe 30–36) ha
cinque righe numerate **da 0 a 4**:

| Riga | Scope | Stato |
|---|---|---|
| 0 — Site + SEO | URL bilingui, metadati, structured data, sitemap | fatto (#22, #27) |
| 1 — Admin v4 | pannello phone-first, PWA push, rules admin, notifier Apps Script | fatto (#28–#33) |
| 2 — Go-live polish | account host, contatti reali, pagine legali, install iPhone | azioni owner |
| **3 — Growth & analytics** | **Search Console, Google Business Profile, eventi analytics, dominio** | **pianificata** |
| 4 — Open | pagamenti/prezzi, ruoli multiutente | fuori scope |

La fase analytics è quindi la riga **"3 — Growth & analytics"**. "Fase 5" corrisponde invece al
**punto 5 della lista «Owner actions»** della vision (riga 68): «**Growth** — Search Console +
sitemap, Google Business Profile, analytics decision, custom domain». Cioè: la numerazione "fase
5" è quella delle *owner actions*, non quella della roadmap. Requisiti e passi qui sotto coprono
quel punto.

### Requisiti di analytics, come stanno scritti

Da `docs/vision.md` → sezione **"Analytics and measurement"** (righe 38–47):

- l'unica conversione che conta: `booking_request_submitted`;
- intento di contatto: `whatsapp_click`, `email_click`, `phone_click`;
- funnel: `calendar_opened`, `dates_selected`; engagement: `gallery_open`;
- revisione **mensile** di impression/click per query da Search Console (l'unico dato reale di
  keyword);
- tool: GA4 (gratis, familiare) o Plausible (privacy-first, a pagamento) — **decisione aperta**.

Da `docs/seo-marketing-review.md` → **"Measurement plan (once analytics exists)"** (righe
172–181) e punto 4 delle owner actions (righe 122–124) si aggiungono:

- `booking_bar_click` (barra sticky) — capire se la barra merita;
- `calendar_opened` / `dates_selected` come punto di abbandono del funnel;
- GSC impressions/clicks per query, revisione mensile.

*Questa guida assume GA4.* Se la decisione finale fosse Plausible, i passi 2, 5 e 6 cambiano e il
collegamento GA4 ↔ Search Console non esiste (Plausible non ha quell'integrazione).

---

## 3. I servizi: cosa sono e a cosa servono

| Servizio | Cosa misura | Dove sta | Serve codice? |
|---|---|---|---|
| **Google Analytics 4 (GA4)** | cosa fanno gli utenti **dentro** il sito: traffico, sorgenti, pagine viste, eventi, conversioni | proprietà su analytics.google.com + tag `gtag.js` nelle pagine | **sì** (tag + eventi) |
| **Google Search Console (GSC)** | come il sito appare **su Google**: query di ricerca, impression, click, CTR, posizione, indicizzazione, sitemap, errori di scansione | proprietà su search.google.com/search-console, verificata | no tag; serve la verifica della proprietà |
| **Google Business Profile** | la scheda attività nelle ricerche/mappe locali (recensioni, foto, link al sito) | profile.google.com | no: è fuori dal sito; citato dalla fase 5 ma non è analytics di sito |
| **Firebase Hosting** | serve le pagine (già attivo) | progetto `villa-serenita-san-teodoro` | serve per il deploy del tag e per l'header CSP |

Differenza chiave da tenere a mente: **GA4 vede solo chi arriva sul sito**; **GSC vede cosa
succede su Google prima del click** (query, impression) e se le pagine sono indicizzabili. Per
questo servono entrambi: senza GSC non sai *da quali ricerche* arriva la gente; senza GA4 non sai
*cosa fa* quando arriva.

### Mappa delle connessioni

```
                 visitatore (browser)
                        │  HTTPS
                        ▼
   sito pubblico  /  (index.html)  e  /en/  (generato)
        │   tag gtag.js nel <head>  (NON in /admin)
        │
        └──► GA4  — proprietà "VillaST" + stream web (G-XXXXXXX)
                  ├─ Report: Realtime, Engagement, Pagine, Eventi
                  └─ Evento chiave (conversione): booking_request_submitted

                 utente che cerca su Google
                        │
                        ▼
                    Google Search  ──►  sito
                        │
                        └──► Search Console — proprietà verificata
                               ├─ Performance: query, impression, click, CTR, posizione
                               ├─ Pagine: indicizzazione + sitemap.xml inviata
                               └─ collegamento (link prodotto) ──► GA4
                                       report "Search Console" dentro GA4
```

Le tre frecce che contano: **sito → tag → GA4** (misura il comportamento), **Google → GSC → sito**
(misura come ti trovano), **GSC ↔ GA4** (le query di ricerca entrano nei report GA4).

---

## 4. Prerequisiti

1. **Account Google con accesso al progetto Firebase** `villa-serenita-san-teodoro` (serve per
   deploy e per l'header CSP).
2. **Contatti reali pubblicati.** Oggi il link WhatsApp è `wa.me/393000000000` (placeholder,
   `index.html`, footer): misurare `whatsapp_click` su un link morto produce dati falsi. È la
   owner action n. 1 della vision.
3. **Pagine legali + consenso.** GA4 usa cookie: prima di raccogliere dati serve privacy policy /
   cookie notice (owner action n. 4 della vision; punto 5 delle owner actions della review).
   Finché non ci sono, si installa il tag in **Consent Mode** con default "denied".
4. **Consapevolezza sull'URL:** il sito è su `*.web.app`, che non è un dominio tuo → in GSC si
   usa una proprietà **Prefisso URL** con verifica via tag HTML, *non* una proprietà Dominio (DNS).
5. **Decisione GA4 vs Plausible** (vision, riga 47). Qui si assume GA4.

---

## 5. I passi, in ordine

### Passo 1 — Creare la proprietà GA4 e lo stream web

1. analytics.google.com → **Amministrazione** → *Crea* → **Proprietà** (nome: `VillaST`; fuso
   `Europe/Rome`; valuta `EUR`).
2. Nella proprietà → **Stream di dati** → *Web*: URL `https://villa-serenita-san-teodoro.web.app`,
   nome stream `VillaST sito`.
3. Annotare l'**ID di misurazione** `G-XXXXXXX` (Serve al passo 2).

*Verifica:* lo stream appare in "Stream di dati" e Google mostra lo snippet da installare.

### Passo 2 — Modifiche al sito per installare il tag ⚠️ NON eseguite in questo task

Sono modifiche al codice, da fare in un task dedicato (branch + PR, come da `AGENTS.md`), in
quest'ordine:

1. **`index.html`, nel `<head>`**: snippet `gtag.js` con l'ID `G-XXXXXXX` (+ Consent Mode con
   default `denied`). Un solo file da editare: `en/index.html` è **generato** da
   `tools/build-en.mjs`, che copia la pagina e sostituisce solo i metadati IT→EN, quindi il tag
   finisce in entrambe le lingue.
2. **`firebase.json` → header `Content-Security-Policy`**: la CSP attuale (`script-src 'self'
   'unsafe-inline' https://www.gstatic.com https://cdn.jsdelivr.net https://maps.googleapis.com`;
   `connect-src … solo googleapis/firebase/gstatic`) **blocca** gtag. Da aggiungere:
   `https://www.googletagmanager.com` a `script-src`,
   `https://*.google-analytics.com https://*.analytics.google.com` a `connect-src`,
   e gli stessi host a `img-src` per il pixel di fallback.
3. **NON mettere il tag in `admin.html`**: è `noindex` e le visite dell'host sporcherebbero i
   dati del sito pubblico.
4. **Rigenerare l'inglese**: `node tools/build-en.mjs` (riscrive `en/index.html`, che è
   committato).
5. **Gate SEO**: `node tools/check-seo.mjs` deve uscire con codice 0 (55 assert).
6. **Deploy**: merge su `main` (GitHub Actions) oppure `firebase deploy --only hosting`.

*Verifica:* `curl -s https://villa-serenita-san-teodoro.web.app/ | grep -c googletagmanager` ≥ 1,
stesso risultato su `/en/`, nessun errore CSP in console.

### Passo 3 — Verificare la proprietà in Search Console

1. search.google.com/search-console → **Aggiungi proprietà** → tipo **Prefisso URL**:
   `https://villa-serenita-san-teodoro.web.app/`.
2. Verifica con **tag HTML**: Google dà un `<meta name="google-site-verification" …>` da mettere
   nel `<head>` di `index.html`. Anche questa è una **modifica al sito**: stesso flusso del passo
   2 (edit → `node tools/build-en.mjs` → `node tools/check-seo.mjs` → deploy).
3. In alternativa (senza toccare l'HTML) si carica il file di verifica di Google alla radice del
   sito — ma in questo repo è più pulito il meta tag.

*Verifica:* GSC mostra **"Proprietà verificata"**. Se compare "Impossibile verificare", la causa
quasi sempre è che la modifica non è ancora deployata: ricontrolla con `curl -s <url> | grep
google-site-verification`.

### Passo 4 — Inviare la sitemap in Search Console

`/sitemap.xml` **esiste già** (fatto nella fase 0: due URL, IT `/` ed EN `/en/`, con `hreflang`
alternates).

1. GSC → **Sitemap** → inserire `sitemap.xml` → *Invia*.
2. GSC aggiornerà da sé il campo `lastmod` quando cambia il contenuto marketing (commento in testa
   al file).

*Verifica:* stato **"Operazione riuscita"** e URL scoperti ≥ 2; nelle prossime ore/giorni le pagine
compaiono in **Pagine** con stato "Indicizzata".

### Passo 5 — Collegare GA4 ↔ Search Console

1. GA4 → **Amministrazione** → **Collegamenti prodotto** → **Collegamenti Search Console** →
   *Collega* → scegli la proprietà GSC → *Conferma* → *Consenti*.
2. Prerequisito: lo **stesso account Google** deve avere permessi su entrambi i lati — in GA4
   almeno *Editor*, in GSC *Proprietario* o utente con autorizzazione completa. Se la proprietà non
   appare nell'elenco, è sempre un problema di permessi, non di collegamento.

*Verifica:* la proprietà risulta collegata in GA4; entro 24–48 h si popola il report GA4
**Acquisizione → Query di Search Console** (query, landing page, click/impression), e i dati
query diventano disponibili nelle Esplorazioni.

### Passo 6 — Definire gli eventi / conversioni richiesti ⚠️ NON eseguiti in questo task

Tabella evento → dove va emesso nel codice attuale:

| Evento richiesto | Dove nel codice | Come |
|---|---|---|
| `booking_request_submitted` | `js/reservations.js`, `form.addEventListener('submit')` | nel ramo di successo, **dopo** `await addDoc(collection(db,'reservations'), …)` (accanto a `form.style.display='none'`): così conta solo le richieste salvate, non gli invii falliti |
| `whatsapp_click` | `index.html`, footer, unico link `wa.me` con `class="btn btn--whatsapp"` (accanto a `<!-- OWNER: replace 393000000000 … -->`) | listener sul click |
| `email_click` | `index.html`, link `mailto:rifugiotavolara.st@gmail.com` | listener sul click |
| `phone_click` | **nessun elemento**: non esiste link `tel:` in `index.html` | gap: la vision chiede l'evento ma manca il link telefonico. Va prima aggiunto il link (modifica al sito, non in questo task) oppure l'evento si rimanda |
| `booking_bar_click` | `index.html`, `#booking-bar` (CTA "Verifica disponibilità") | listener sul click |
| `calendar_opened` | `js/calendar.js`, `flatpickr(checkInEl, {…})` | callback `onOpen` |
| `dates_selected` | `js/calendar.js`, callback `onChange` | solo se `selectedDates.length > 0` |
| `gallery_open` | `js/app.js`, `openLightbox(index)` (click sulle immagini della gallery) | evento all'apertura del lightbox |

Poi in GA4 → **Amministrazione → Eventi**: marcare `booking_request_submitted` come **evento
chiave** (conversione). Gli altri restano eventi normali, leggibili nei report Eventi e nelle
Esplorazioni (si possono promuovere a eventi chiave per contare micro-conversioni).

*Verifica:* GA4 → **Realtime** mentre si prova l'azione sul sito.

### Passo 7 — Revisione mensile

Cadenza definita dalla vision: GSC **Performance** (query, click, impression, CTR, posizione,
filtro IT/EN) + GA4 confronto periodo (sorgenti, pagine, eventi). È l'unica fonte reale di dati
sulle keyword: le query elencate in `docs/seo-marketing-review.md` sono ipotesi di intento, non
volumi misurati.

---

## 6. Come verificare che tutto funzioni

**Tag installato e non bloccato**

```bash
curl -s https://villa-serenita-san-teodoro.web.app/    | grep -c googletagmanager   # ≥ 1
curl -s https://villa-serenita-san-teodoro.web.app/en/ | grep -c googletagmanager   # ≥ 1
node tools/check-seo.mjs    # deve uscire 0 (nessuna regressione SEO)
```

Nel browser (console): `typeof gtag === 'function'`, `window.dataLayer` popolato, e **nessun
errore** del tipo `Refused to load the script … googletagmanager.com` (se c'è, il passo 2.2 — CSP —
è incompleto).

**GA4 riceve dati** — GA4 → **Report → Realtime**: aprendo il sito in un'altra finestra deve
comparire 1 utente attivo e l'evento `page_view`. Per il debug evento per evento usare
**Amministrazione → DebugView** con l'estensione Google Analytics Debugger (o Tag Assistant).

**Eventi custom** — compaiono in Realtime entro pochi secondi, nei report standard entro 24–48 h.
Prova end-to-end: inviare una richiesta di prenotazione di test dal sito e vedere
`booking_request_submitted` in Realtime (la richiesta entra davvero in Firestore: cancellala dal
pannello `/admin`). `gallery_open` → click su una foto; `calendar_opened`/`dates_selected` → aprire
il calendario e scegliere due date; `booking_bar_click` → click sulla barra sticky dopo aver
scrollato l'hero.

**Consenso** — con Consent Mode attivo, in stato "rifiutato" dal banner **non** deve partire
traffico verso GA4 (controlla la rete nella console del browser): nessuna richiesta a
`google-analytics.com`.

**Search Console** — "Proprietà verificata"; **Sitemap** → "Operazione riuscita" con ≥ 2 URL;
**Controllo URL** su `/` e `/en/` → "URL nella sitemap", "Pubblicazione possibile", nessun errore
di rendering; dopo 2–3 giorni il report **Performance** mostra impression e query reali.

**Collegamento GA4 ↔ GSC** — GA4 → Amministrazione → Collegamenti prodotto: la proprietà appare
collegata, e il report "Search Console" si popola entro 48 h.

---

## 7. Checklist finale

- [ ] Proprietà GA4 creata, stream web con l'URL del sito, ID `G-XXXXXXX` annotato
- [ ] Snippet `gtag.js` nel `<head>` di `index.html` (vale anche per `/en/` dopo `build-en.mjs`)
- [ ] CSP in `firebase.json` aggiornata (`googletagmanager.com` in `script-src`, domini
      google-analytics in `connect-src` e `img-src`)
- [ ] Tag **assente** da `admin.html`
- [ ] `node tools/build-en.mjs` rieseguito e `en/index.html` committato
- [ ] `node tools/check-seo.mjs` esce 0
- [ ] Deploy fatto (`main` o `firebase deploy --only hosting`) e tag visibile in `curl` su `/` e `/en/`
- [ ] Proprietà GSC (Prefisso URL) verificata con meta tag deployato
- [ ] `sitemap.xml` inviata in GSC, stato "Operazione riuscita"
- [ ] GA4 ↔ Search Console collegati, report "Search Console" visibile in GA4
- [ ] Consenso (Consent Mode) e pagine privacy/cookie pubblicate
- [ ] Tutti gli eventi del measurement plan emessi (e `phone_click` risolto: link `tel:` aggiunto
      oppure evento rimandato esplicitamente)
- [ ] `booking_request_submitted` marcato come evento chiave in GA4
- [ ] Revisione mensile messa in calendario (GSC Performance + GA4)

---

## 8. Fuori scope di questa guida

- **Creare gli account, installare il tag in produzione, modificare il codice del sito.** I passi
  2, 3 e 6 sono elencati come da fare, *non* eseguiti qui: vanno in un task dedicato con branch +
  PR.
- **SEO avanzato** oltre a quanto serve per capire e collegare Search Console.
- **Plausible**: alternativa citata dalla vision; se la scelta cade lì, il passo 2 resta (tag
  diverso), i passi 5 e 6 cambiano, il collegamento GSC ↔ analytics non esiste.
- **Google Business Profile**: la fase 5 lo include, ma non è analytics di sito e non tocca il
  codice.

## Riferimenti

- Fase analytics + requisiti eventi: `docs/vision.md` (righe 30–36 roadmap, 38–47 "Analytics and
  measurement", 68 owner action n. 5 "Growth")
- Measurement plan, owner actions, audit: `docs/seo-marketing-review.md` (righe 122–124, 172–181)
- CSP, header, deploy, ignore list: `firebase.json`
- Generatore della pagina EN: `tools/build-en.mjs`; gate SEO: `tools/check-seo.mjs`
- Punti di emissione eventi: `js/reservations.js`, `js/app.js`, `js/calendar.js`, `index.html`
- Convenzioni (branch + PR, nessuna modifica diretta a `main`): `AGENTS.md`
