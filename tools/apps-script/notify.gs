/**
 * VillaST notifier — Apps Script, owned by rifugiotavolara.st@gmail.com
 * ---------------------------------------------------------------------
 * Runs on a 5-minute time trigger on Google's servers (free tier, no Blaze).
 *
 *   tick()  every 5 min
 *     1. push  : every `pending` reservation whose pushState != 'sent'
 *                -> FCM HTTP v1 to every pushTokens token, then mark sent
 *     2. mail  : every `confirmed` reservation whose mailState != 'sent'
 *                -> MailApp confirmation email to the guest in the form's language
 *   2b. mail  : every `rejected` reservation whose rejectMailState == 'new'
 *                -> MailApp rejection email to the guest, then mark sent
 *     3. tests : every pushTests doc with sent != true
 *                -> test push, then mark sent
 *
 * Design + rationale: docs/admin-panel-v4-design.md
 * Setup checklist   : tools/apps-script/README.md
 *
 * Quotas (consumer account): 90 min/day trigger runtime, 20k UrlFetch/day,
 * 100 mail recipients/day — this script uses < 10 min and < 5 mails per day.
 * Time triggers fire "approximately": notification latency is <= ~5-6 minutes.
 */

const PROJECT_ID = 'villa-serenita-san-teodoro';
const FS_BASE = `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents`;
const SITE_URL = 'https://villa-serenita-san-teodoro.web.app';
const ADMIN_URL = SITE_URL + '/admin';
const TICK_MINUTES = 5;
const SCOPES = [
  'https://www.googleapis.com/auth/datastore',
  'https://www.googleapis.com/auth/firebase.messaging'
];

/**
 * Villa facts used by the confirmation email.
 * OWNER: replace every placeholder below (phone, IBAN) with the real values.
 */
const VILLA_ = {
  phone: '+39 000 000 0000',                 // OWNER: real phone / WhatsApp
  email: 'rifugiotavolara.st@gmail.com',
  iban: 'IT00 0000 0000 0000 0000 0000 000', // OWNER: real IBAN (placeholder on purpose)
  ibanHolder: 'Rifugio Tavolara',
  address: 'Villaggio li piri, piano terra, 07052 San Teodoro (Sardegna)',
  mapsUrl: 'https://www.google.com/maps/search/?api=1&query=Villaggio+li+piri+San+Teodoro',
  cin: 'IT090092C2000S4969',
  checkIn: { it: 'dalle 15:00', en: 'from 15:00' },
  checkOut: { it: 'entro le 10:00', en: 'by 10:00' }
};

/** Entry point — the time trigger calls this. */
function tick() {
  if (!PropertiesService.getScriptProperties().getProperty('FIREBASE_SA')) {
    console.error('FIREBASE_SA is not set in Script Properties — see README.md');
    return;
  }
  let token;
  try { token = getAccessToken_(); }
  catch (err) { console.error('token exchange failed: ' + err); return; }

  try { pushNewRequests_(token); } catch (err) { console.error('push failed: ' + err); }
  try { mailConfirmed_(token); } catch (err) { console.error('mail failed: ' + err); }
  try { mailRejected_(token); } catch (err) { console.error('rejection mail failed: ' + err); }
  try { sendTestPushes_(token); } catch (err) { console.error('test push failed: ' + err); }
}

/** Run this once from the Apps Script editor to install the trigger. */
function installTrigger() {
  ScriptApp.getProjectTriggers().forEach((t) => {
    if (t.getHandlerFunction() === 'tick') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('tick').timeBased().everyMinutes(TICK_MINUTES).create();
  console.log(`trigger installed: tick() every ${TICK_MINUTES} minutes`);
}

/** Run this to see what the script can see (no writes, no sends). */
function checkSetup() {
  const props = PropertiesService.getScriptProperties();
  console.log('FIREBASE_SA set: ' + Boolean(props.getProperty('FIREBASE_SA')));
  console.log('triggers: ' + ScriptApp.getProjectTriggers().map((t) => t.getHandlerFunction()).join(', '));
  try {
    const token = getAccessToken_();
    console.log('pushTokens: ' + fsQuery_(token, 'pushTokens').length);
    console.log('pending(not sent): ' + fsQuery_(token, 'reservations', 'status', 'pending').filter((r) => r.data.pushState !== 'sent').length);
    console.log('confirmed(not mailed): ' + fsQuery_(token, 'reservations', 'status', 'confirmed').filter((r) => r.data.mailState !== 'sent').length);
    console.log('rejected(to mail): ' + fsQuery_(token, 'reservations', 'status', 'rejected').filter((r) => r.data.rejectMailState === 'new').length);
    console.log('mail quota left today: ' + MailApp.getRemainingDailyQuota());
  } catch (err) {
    console.error('checkSetup failed: ' + err);
  }
}

/* ── auth: service account -> OAuth access token (RS256 JWT, no libraries) ── */

function getAccessToken_() {
  const cache = CacheService.getScriptCache();
  const cached = cache.get('access_token');
  if (cached) return cached;

  const sa = JSON.parse(PropertiesService.getScriptProperties().getProperty('FIREBASE_SA'));
  const iat = Math.floor(Date.now() / 1000);
  const header = b64_(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = b64_(JSON.stringify({
    iss: sa.client_email,
    scope: SCOPES.join(' '),
    aud: 'https://oauth2.googleapis.com/token',
    iat: iat,
    exp: iat + 3600
  }));
  const signature = Utilities.base64EncodeWebSafe(
    Utilities.computeRsaSha256Signature(header + '.' + claims, sa.private_key)
  ).replace(/=+$/, '');

  const res = UrlFetchApp.fetch('https://oauth2.googleapis.com/token', {
    method: 'post',
    payload: {
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: header + '.' + claims + '.' + signature
    },
    muteHttpExceptions: true
  });
  const body = JSON.parse(res.getContentText());
  if (!body.access_token) throw new Error(res.getResponseCode() + ' ' + res.getContentText());
  cache.put('access_token', body.access_token, 3300);
  return body.access_token;
}

function b64_(s) {
  return Utilities.base64EncodeWebSafe(s, Utilities.Charset.UTF_8).replace(/=+$/, '');
}

/* ── Firestore REST helpers ──────────────────────────────────────────────── */

function value_(field) {
  if (!field) return null;
  if (field.stringValue !== undefined) return field.stringValue;
  if (field.integerValue !== undefined) return Number(field.integerValue);
  if (field.booleanValue !== undefined) return field.booleanValue;
  if (field.timestampValue !== undefined) return field.timestampValue;
  return null;
}

function doc_(document) {
  const data = {};
  Object.keys(document.fields || {}).forEach((k) => { data[k] = value_(document.fields[k]); });
  return { id: document.name.split('/').pop(), data: data };
}

function fsVal_(v) {
  if (v instanceof Date) return { timestampValue: v.toISOString() };
  if (typeof v === 'number') return { integerValue: String(v) };
  if (typeof v === 'boolean') return { booleanValue: v };
  return { stringValue: String(v) };
}

function fsQuery_(token, collectionId, field, value) {
  const structuredQuery = { from: [{ collectionId: collectionId }] };
  if (field) {
    structuredQuery.where = {
      fieldFilter: { field: { fieldPath: field }, op: 'EQUAL', value: { stringValue: value } }
    };
  }
  const res = UrlFetchApp.fetch(FS_BASE + ':runQuery', {
    method: 'post',
    contentType: 'application/json',
    headers: { Authorization: 'Bearer ' + token },
    payload: JSON.stringify({ structuredQuery: structuredQuery }),
    muteHttpExceptions: true
  });
  if (res.getResponseCode() !== 200) throw new Error('runQuery ' + res.getResponseCode() + ': ' + res.getContentText());
  return JSON.parse(res.getContentText()).filter((r) => r.document).map((r) => doc_(r.document));
}

function fsPatch_(token, docPath, fields) {
  const mask = Object.keys(fields).map((k) => 'updateMask.fieldPaths=' + k).join('&');
  const res = UrlFetchApp.fetch(FS_BASE + '/' + docPath + '?' + mask, {
    method: 'patch',
    contentType: 'application/json',
    headers: { Authorization: 'Bearer ' + token },
    payload: JSON.stringify({ fields: fields }),
    muteHttpExceptions: true
  });
  if (res.getResponseCode() !== 200) throw new Error('patch ' + docPath + ' ' + res.getResponseCode() + ': ' + res.getContentText());
}

function fsDelete_(token, docPath) {
  const res = UrlFetchApp.fetch(FS_BASE + '/' + docPath, {
    method: 'delete',
    headers: { Authorization: 'Bearer ' + token },
    muteHttpExceptions: true
  });
  if (res.getResponseCode() !== 200) throw new Error('delete ' + docPath + ' ' + res.getResponseCode());
}

/* ── FCM ─────────────────────────────────────────────────────────────────── */

function sendPush_(token, fcmToken, title, body, tagId) {
  const res = UrlFetchApp.fetch(`https://fcm.googleapis.com/v1/projects/${PROJECT_ID}/messages:send`, {
    method: 'post',
    contentType: 'application/json',
    headers: { Authorization: 'Bearer ' + token },
    payload: JSON.stringify({
      message: {
        token: fcmToken,
        notification: { title: title, body: body },
        webpush: {
          // One display path only: the browser renders this block and sw.js does
          // not call showNotification again (that showed every push twice).
          notification: {
            icon: SITE_URL + '/images/icon-192.png',
            badge: SITE_URL + '/images/icon-192.png',
            tag: 'villast-' + (tagId || 'push'),
            lang: 'it'
          },
          fcm_options: { link: ADMIN_URL }
        }
      }
    }),
    muteHttpExceptions: true
  });
  return res.getResponseCode(); // 404/410 => token gone
}

/* ── flow 1: new request -> push ────────────────────────────────────────── */

function pushNewRequests_(token) {
  const tokens = fsQuery_(token, 'pushTokens');
  if (!tokens.length) return;

  const pending = fsQuery_(token, 'reservations', 'status', 'pending')
    .filter((r) => r.data.pushState !== 'sent');
  if (!pending.length) return;

  pending.forEach((r) => {
    const title = 'Nuova richiesta di prenotazione';
    const body = `${r.data.name || 'Ospite'} · ${date_(r.data.checkIn)}-${date_(r.data.checkOut)} · ${r.data.guests || '?'} ospiti`;
    const gone = [];
    tokens.forEach((t) => {
      const code = sendPush_(token, t.data.token, title, body, r.id);
      if (code === 404 || code === 410) gone.push(t.id);
      else if (code !== 200) console.error('push to ' + t.id.slice(0, 10) + " -> " + code + ' ' + t.data.token.slice(0, 12));
    });
    gone.forEach((id) => fsDelete_(token, 'pushTokens/' + id));
    fsPatch_(token, 'reservations/' + r.id, { pushState: fsVal_('sent'), pushSentAt: fsVal_(new Date()) });
  });
  console.log('pushed ' + pending.length + ' request(s) to ' + tokens.length + ' device(s)');
}

/* ── email building blocks (shared by the confirmation and rejection mails) ── */

/** One label/value table row. ponytail: tables + inline styles only — mail clients drop <style>. */
function mailRow_(label, value) {
  return '<tr>' +
    '<td style="padding:6px 0;font:13px/1.5 Arial,Helvetica,sans-serif;color:#6E6A5E;width:36%;vertical-align:top;">' + label + '</td>' +
    '<td style="padding:6px 0;font:14px/1.5 Arial,Helvetica,sans-serif;color:#1A3C5E;font-weight:bold;">' + value + '</td>' +
    '</tr>';
}

/* ── flow 2: confirmed -> guest email ───────────────────────────────────── */

function mailConfirmed_(token) {
  const toMail = fsQuery_(token, 'reservations', 'status', 'confirmed')
    .filter((r) => r.data.mailState !== 'sent' && r.data.source !== 'admin' && r.data.email);
  if (!toMail.length) return;

  if (MailApp.getRemainingDailyQuota() < toMail.length) {
    console.error('not enough mail quota left today');
    return;
  }

  toMail.forEach((r) => {
    const en = r.data.lang === 'en';
    MailApp.sendEmail({
      to: r.data.email,
      name: 'Rifugio Tavolara',
      subject: mailSubject_(en, r.data),
      htmlBody: mailHtml_(en, r.data)
    });
    fsPatch_(token, 'reservations/' + r.id, { mailState: fsVal_('sent'), mailSentAt: fsVal_(new Date()) });
  });
  console.log('sent ' + toMail.length + ' confirmation email(s)');
}

function mailSubject_(en, d) {
  const first = String(d.name || '').trim().split(/\s+/)[0];
  const when = `${date_(d.checkIn)} → ${date_(d.checkOut)}`;
  return en
    ? `${first ? `Hi ${first}, your booking` : 'Your booking'} at Rifugio Tavolara is confirmed — ${when}`
    : `${first ? `Ciao ${first}, la tua` : 'La tua'} prenotazione al Rifugio Tavolara è confermata — ${when}`;
}

/** Confirmation email. ponytail: one table + inline styles only — mail clients drop <style>. */
function mailHtml_(en, d) {
  const first = String(d.name || '').trim().split(/\s+/)[0];
  const T = (it, eng) => (en ? eng : it);
  const when = `${date_(d.checkIn)} → ${date_(d.checkOut)}`;
  const ms = Date.parse(d.checkOut) - Date.parse(d.checkIn);
  const nights = Number.isFinite(ms) && ms > 0 ? Math.round(ms / 86400000) : 0;
  const guests = d.guests ? `${d.guests} ${T('ospiti', 'guests')}` : '';
  const meta = [nights ? `${nights} ${T('notti', 'nights')}` : '', guests].filter(Boolean).join(' · ');
  const body = 'font:15px/1.65 Arial,Helvetica,sans-serif;color:#333333;';
  const serif = "font-family:Georgia,'Times New Roman',serif;";

  const row = mailRow_; // shared with the rejection email

  return `<!doctype html>
<html lang="${en ? 'en' : 'it'}">
<body style="margin:0;padding:24px 12px;background:#FAF7F2;">
  <div style="display:none;max-height:0;overflow:hidden;">${T('Confermato', 'Confirmed')}: ${when} — ${VILLA_.address}</div>
  <div style="max-width:560px;margin:0 auto;background:#FFFFFF;border:1px solid #E8D5B7;border-radius:14px;overflow:hidden;">
    <div style="background:#1A3C5E;padding:22px 26px;">
      <div style="${serif}font-size:22px;font-weight:600;color:#F3E7D3;">Rifugio Tavolara</div>
      <div style="font:12px/1.8 Arial,Helvetica,sans-serif;letter-spacing:2px;color:#C9D4E0;">SAN TEODORO · SARDEGNA</div>
    </div>
    <div style="padding:26px;">
      <div style="font:600 12px/1 Arial,Helvetica,sans-serif;letter-spacing:2px;text-transform:uppercase;color:#B0553A;">${T('Prenotazione confermata', 'Booking confirmed')}</div>
      <h1 style="${serif}margin:10px 0 16px;font-size:24px;line-height:1.3;color:#1A3C5E;">${T('Il tuo soggiorno è confermato', 'Your stay is confirmed')}</h1>
      <p style="margin:0 0 18px;${body}">${T('Ciao', 'Hi')}${first ? ' ' + first : ''}, ${T('ti aspettiamo in Sardegna — ecco i dettagli del tuo soggiorno.', 'we look forward to hosting you — here are your stay details.')}</p>
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#FAF7F2;border:1px solid #E8D5B7;border-radius:10px;">
        <tr><td style="padding:14px 18px;">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
            ${row(T('Date', 'Dates'), `${when}${meta ? '<br>' + meta : ''}`)}
            ${row(T('Check-in', 'Check-in'), VILLA_.checkIn[en ? 'en' : 'it'])}
            ${row(T('Check-out', 'Check-out'), VILLA_.checkOut[en ? 'en' : 'it'])}
            ${row(T('Indirizzo', 'Address'), `${VILLA_.address}<br><a href="${VILLA_.mapsUrl}" style="color:#2E86AB;text-decoration:none;">${T('Apri in Google Maps', 'Open in Google Maps')} →</a>`)}
            ${d.quoteTotal ? row(T('Totale indicativo', 'Indicative total'), `€${d.quoteTotal}`) : ''}
          </table>
        </td></tr>
      </table>
      <div style="margin:22px 0 8px;font:600 12px/1 Arial,Helvetica,sans-serif;letter-spacing:2px;text-transform:uppercase;color:#6E6A5E;">${T('Saldo', 'Payment')}</div>
      <p style="margin:0 0 10px;${body}">${T("Il saldo va versato prima dell'arrivo tramite bonifico:", 'The balance is due before arrival by bank transfer:')}</p>
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px dashed #C9B99B;border-radius:10px;">
        <tr><td style="padding:12px 16px;font:14px/1.7 'Courier New',monospace;color:#1A3C5E;">
          <b>${VILLA_.ibanHolder}</b><br>IBAN ${VILLA_.iban}
        </td></tr>
      </table>
      <div style="margin:22px 0 8px;font:600 12px/1 Arial,Helvetica,sans-serif;letter-spacing:2px;text-transform:uppercase;color:#6E6A5E;">${T('Contatti', 'Contact')}</div>
      <p style="margin:0;${body}">
        ${T('Telefono / WhatsApp', 'Phone / WhatsApp')}: <a href="tel:${VILLA_.phone.replace(/\s/g, '')}" style="color:#2E86AB;text-decoration:none;">${VILLA_.phone}</a><br>
        Email: <a href="mailto:${VILLA_.email}" style="color:#2E86AB;text-decoration:none;">${VILLA_.email}</a>
      </p>
      <p style="margin:18px 0 0;${body}">${T('Rispondi a questa email per qualsiasi cosa — a presto in Sardegna!', 'Reply to this email for anything you need — see you in Sardinia!')}</p>
    </div>
    <div style="background:#FAF7F2;border-top:1px solid #E8D5B7;padding:14px 26px;font:12px/1.7 Arial,Helvetica,sans-serif;color:#8A8578;">
      Rifugio Tavolara · ${VILLA_.address} · CIN ${VILLA_.cin}
    </div>
  </div>
</body>
</html>`;
}

/* ── flow 2b: rejected -> guest email (one per decline) ─────────────────── */

/**
 * Decline email. Armed by `rejectMailState:'new'`, written by the admin panel
 * in the same batch as `status:'rejected'` — so reservations rejected before
 * this field existed (no `rejectMailState`) are never mailed retroactively.
 */
function mailRejected_(token) {
  const toMail = fsQuery_(token, 'reservations', 'status', 'rejected')
    .filter((r) => r.data.rejectMailState === 'new' && r.data.source !== 'admin' && r.data.email);
  if (!toMail.length) return;

  if (MailApp.getRemainingDailyQuota() < toMail.length) {
    console.error('not enough mail quota left today');
    return;
  }

  toMail.forEach((r) => {
    const en = r.data.lang === 'en';
    MailApp.sendEmail({
      to: r.data.email,
      name: 'Rifugio Tavolara',
      subject: rejectMailSubject_(en, r.data),
      htmlBody: rejectMailHtml_(en, r.data)
    });
    fsPatch_(token, 'reservations/' + r.id, { rejectMailState: fsVal_('sent'), rejectMailSentAt: fsVal_(new Date()) });
  });
  console.log('sent ' + toMail.length + ' rejection email(s)');
}

function rejectMailSubject_(en, d) {
  const first = String(d.name || '').trim().split(/\s+/)[0];
  const when = `${date_(d.checkIn)} → ${date_(d.checkOut)}`;
  return en
    ? `${first ? `Hi ${first}, your` : 'Your'} dates at Rifugio Tavolara are not available — ${when}`
    : `${first ? `Ciao ${first}, le` : 'Le'} tue date al Rifugio Tavolara non sono disponibili — ${when}`;
}

/** Rejection email — same skeleton as the confirmation, no payment block. */
function rejectMailHtml_(en, d) {
  const first = String(d.name || '').trim().split(/\s+/)[0];
  const T = (it, eng) => (en ? eng : it);
  const when = `${date_(d.checkIn)} → ${date_(d.checkOut)}`;
  const body = 'font:15px/1.65 Arial,Helvetica,sans-serif;color:#333333;';
  const serif = "font-family:Georgia,'Times New Roman',serif;";

  return `<!doctype html>
<html lang="${en ? 'en' : 'it'}">
<body style="margin:0;padding:24px 12px;background:#FAF7F2;">
  <div style="display:none;max-height:0;overflow:hidden;">${T('Date non disponibili', 'Dates not available')}: ${when} — Rifugio Tavolara</div>
  <div style="max-width:560px;margin:0 auto;background:#FFFFFF;border:1px solid #E8D5B7;border-radius:14px;overflow:hidden;">
    <div style="background:#1A3C5E;padding:22px 26px;">
      <div style="${serif}font-size:22px;font-weight:600;color:#F3E7D3;">Rifugio Tavolara</div>
      <div style="font:12px/1.8 Arial,Helvetica,sans-serif;letter-spacing:2px;color:#C9D4E0;">SAN TEODORO · SARDEGNA</div>
    </div>
    <div style="padding:26px;">
      <div style="font:600 12px/1 Arial,Helvetica,sans-serif;letter-spacing:2px;text-transform:uppercase;color:#B0553A;">${T('Richiesta non disponibile', 'Request not available')}</div>
      <h1 style="${serif}margin:10px 0 16px;font-size:24px;line-height:1.3;color:#1A3C5E;">${T('Purtroppo le date non sono disponibili', 'Unfortunately those dates are not available')}</h1>
      <p style="margin:0 0 18px;${body}">${T('Ciao', 'Hi')}${first ? ' ' + first : ''}, ${T('grazie per averci scritto. Al momento non possiamo confermare un soggiorno per il periodo richiesto.', 'thanks for reaching out. We cannot confirm a stay for the requested period at the moment.')}</p>
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#FAF7F2;border:1px solid #E8D5B7;border-radius:10px;">
        <tr><td style="padding:14px 18px;">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
            ${mailRow_(T('Date richieste', 'Requested dates'), when)}
            ${mailRow_(T('Contatti', 'Contact'), `<a href="tel:${VILLA_.phone.replace(/\s/g, '')}" style="color:#2E86AB;text-decoration:none;">${VILLA_.phone}</a> · <a href="mailto:${VILLA_.email}" style="color:#2E86AB;text-decoration:none;">${VILLA_.email}</a>`)}
          </table>
        </td></tr>
      </table>
      <p style="margin:18px 0 0;${body}">${T('Hai date alternative? Rispondi a questa email o scrivici su WhatsApp: troviamo insieme il periodo giusto per te.', 'Do you have alternative dates? Reply to this email or message us on WhatsApp: we will find the right period for you.')}</p>
    </div>
    <div style="background:#FAF7F2;border-top:1px solid #E8D5B7;padding:14px 26px;font:12px/1.7 Arial,Helvetica,sans-serif;color:#8A8578;">
      Rifugio Tavolara · ${VILLA_.address} · CIN ${VILLA_.cin}
    </div>
  </div>
</body>
</html>`;
}

/* ── flow 3: "push di prova" from Impostazioni ──────────────────────────── */

function sendTestPushes_(token) {
  const tests = fsQuery_(token, 'pushTests').filter((t) => t.data.sent !== true);
  if (!tests.length) return;

  const tokens = fsQuery_(token, 'pushTokens');
  tests.forEach((t) => {
    tokens.forEach((p) => {
      sendPush_(token, p.data.token, 'Push di prova — Rifugio Tavolara', 'Se leggi questo, le notifiche funzionano.', t.id);
    });
    fsPatch_(token, 'pushTests/' + t.id, { sent: fsVal_(true), sentAt: fsVal_(new Date()) });
  });
  console.log('sent ' + tests.length + ' test push(es)');
}

/* ── misc ───────────────────────────────────────────────────────────────── */

/** YYYY-MM-DD -> DD/MM */
function date_(iso) {
  if (!iso) return '?';
  const parts = String(iso).split('-');
  return parts.length === 3 ? parts[2] + '/' + parts[1] : String(iso);
}