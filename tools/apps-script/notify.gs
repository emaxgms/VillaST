/**
 * VillaST notifier — Apps Script, owned by rifugiotavolara.st@gmail.com
 * ---------------------------------------------------------------------
 * Runs on a 5-minute time trigger on Google's servers (free tier, no Blaze).
 *
 *   tick()  every 5 min
 *     1. push  : every `pending` reservation whose pushState != 'sent'
 *                -> FCM HTTP v1 to every pushTokens token, then mark sent
 *     2. mail  : every `confirmed` reservation whose mailState != 'sent'
 *                -> MailApp email to the guest in the form's language
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
const ADMIN_URL = 'https://villa-serenita-san-teodoro.web.app/admin';
const TICK_MINUTES = 5;
const SCOPES = [
  'https://www.googleapis.com/auth/datastore',
  'https://www.googleapis.com/auth/firebase.messaging'
];

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

function sendPush_(token, fcmToken, title, body) {
  const res = UrlFetchApp.fetch(`https://fcm.googleapis.com/v1/projects/${PROJECT_ID}/messages:send`, {
    method: 'post',
    contentType: 'application/json',
    headers: { Authorization: 'Bearer ' + token },
    payload: JSON.stringify({
      message: {
        token: fcmToken,
        notification: { title: title, body: body },
        webpush: { fcm_options: { link: ADMIN_URL } }
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
      const code = sendPush_(token, t.data.token, title, body);
      if (code === 404 || code === 410) gone.push(t.id);
      else if (code !== 200) console.error('push to ' + t.id.slice(0, 10) + " -> " + code + ' ' + t.data.token.slice(0, 12));
    });
    gone.forEach((id) => fsDelete_(token, 'pushTokens/' + id));
    fsPatch_(token, 'reservations/' + r.id, { pushState: fsVal_('sent'), pushSentAt: fsVal_(new Date()) });
  });
  console.log('pushed ' + pending.length + ' request(s) to ' + tokens.length + ' device(s)');
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
      subject: en
        ? `Booking confirmed — Rifugio Tavolara (${date_(r.data.checkIn)}–${date_(r.data.checkOut)})`
        : `Prenotazione confermata — Rifugio Tavolara (${date_(r.data.checkIn)}–${date_(r.data.checkOut)})`,
      htmlBody: mailHtml_(en, r.data)
    });
    fsPatch_(token, 'reservations/' + r.id, { mailState: fsVal_('sent'), mailSentAt: fsVal_(new Date()) });
  });
  console.log('sent ' + toMail.length + ' confirmation email(s)');
}

function mailHtml_(en, d) {
  const name = String(d.name || '').split(' ')[0] || (en ? 'there' : 'ciao');
  const dates = `${date_(d.checkIn)} → ${date_(d.checkOut)}`;
  const lines = en
    ? [`Hi ${name},`, 'your stay at Rifugio Tavolara is confirmed.', `<b>Dates:</b> ${dates} (${d.guests || '?'} guests)`,
       'Address: Villaggio li piri, ground floor, 07052 San Teodoro (Sardinia).',
       'Payment is due before arrival by bank transfer — we will send the details separately.',
       'Reply to this email for anything you need. See you in Sardinia!']
    : [`Ciao ${name},`, 'il tuo soggiorno al Rifugio Tavolara è confermato.', `<b>Date:</b> ${dates} (${d.guests || '?'} ospiti)`,
       'Indirizzo: Villaggio li piri, piano terra, 07052 San Teodoro (Sardegna).',
       'Il saldo è dovuto prima dell\'arrivo tramite bonifico — ti inviamo i dettagli a parte.',
       'Rispondi a questa email per qualsiasi cosa. A presto in Sardegna!'];
  return lines.map((l, i) => (i === 0 ? `<p><b>${l}</b></p>` : `<p>${l}</p>`)).join('');
}

/* ── flow 3: "push di prova" from Impostazioni ──────────────────────────── */

function sendTestPushes_(token) {
  const tests = fsQuery_(token, 'pushTests').filter((t) => t.data.sent !== true);
  if (!tests.length) return;

  const tokens = fsQuery_(token, 'pushTokens');
  tests.forEach((t) => {
    tokens.forEach((p) => {
      sendPush_(token, p.data.token, 'Push di prova — Rifugio Tavolara', 'Se leggi questo, le notifiche funzionano.');
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