/**
 * test/rules.test.mjs — Firestore security-rule checks, no npm dependencies.
 *
 * Talks the Firestore REST protocol straight to the emulator; unsigned JWTs
 * are accepted there for rules evaluation (same mechanism as
 * @firebase/rules-unit-testing, without the dependency).
 *
 * Run:
 *   npx -y firebase-tools@latest emulators:exec --only firestore \
 *     --project demo-villast "node test/rules.test.mjs"
 *
 * Exits non-zero on the first failing expectation set.
 */

const PROJECT = process.env.FIRESTORE_PROJECT || 'demo-villast';
const HOST = process.env.FIRESTORE_EMULATOR_HOST || '127.0.0.1:8081';
const BASE = `http://${HOST}/v1/projects/${PROJECT}/databases/(default)/documents`;
const RUN = Math.random().toString(36).slice(2, 8);

let failures = 0;
let passed = 0;

function check(name, condition, detail) {
  if (condition) { passed++; console.log(`  ok   ${name}`); }
  else { failures++; console.log(`  FAIL ${name}${detail ? ' — ' + detail : ''}`); }
}

function tokenFor(uid) {
  const enc = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  return [
    enc({ alg: 'none', typ: 'JWT' }),
    enc({
      iss: `https://securetoken.google.com/${PROJECT}`,
      aud: PROJECT,
      sub: uid,
      user_id: uid,
      iat: now,
      exp: now + 3600
    }),
    'sig'
  ].join('.');
}

function authHeader(token) {
  if (!token) return {};
  return { Authorization: `Bearer ${token}` };
}

async function req(method, path, { token, body } = {}) {
  const res = await fetch(BASE + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...authHeader(token) },
    body: body ? JSON.stringify(body) : undefined
  });
  return res.status;
}

const S = (v) => ({ stringValue: v });
const I = (v) => ({ integerValue: String(v) });

function reservationBody(status, source, extra = {}) {
  return {
    fields: {
      name: S('Test Guest'), email: S('guest@example.com'), phone: S('+39 000'),
      checkIn: S('2026-07-12'), checkOut: S('2026-07-18'), guests: I(2),
      status: S(status), source: S(source), ...extra
    }
  };
}

const OWNER = 'owner';               // emulator bypass token: sets up fixtures
const ADMIN = tokenFor('admin1');     // uid with an admins/ doc
const USER = tokenFor('user1');       // authenticated, not an admin

async function main() {
  console.log(`rules test — project ${PROJECT}, emulator ${HOST}`);

  const day = `2026-07-${String(10 + (RUN.charCodeAt(0) % 18)).padStart(2, '0')}`;

  // ── guest flow: pending create allowed, everything else not ────────────
  let st = await req('POST', `/reservations?documentId=pending_${RUN}`, { body: reservationBody('pending', 'guest') });
  check('guest can create a pending request', st === 200, `status ${st}`);

  st = await req('POST', `/reservations?documentId=confirmed_${RUN}`, { body: reservationBody('confirmed', 'guest') });
  check('guest cannot create a confirmed reservation', st === 403, `status ${st}`);

  st = await req('POST', `/reservations?documentId=blocked_${RUN}`, { body: reservationBody('blocked', 'guest') });
  check('guest cannot create a blocked entry', st === 403, `status ${st}`);

  st = await req('POST', `/reservations?documentId=incomplete_${RUN}`, {
    body: { fields: { status: S('pending'), source: S('guest') } }
  });
  check('guest create without name/email/dates is refused', st === 403, `status ${st}`);

  // ── reads are admin-only ───────────────────────────────────────────────
  st = await req('GET', '/reservations', {});
  check('anonymous cannot read reservations', st === 403, `status ${st}`);

  st = await req('GET', '/reservations', { token: USER });
  check('authenticated non-admin cannot read reservations', st === 403, `status ${st}`);

  // ── admin fixture + admin access ───────────────────────────────────────
  st = await req('POST', `/admins?documentId=admin1`, { token: OWNER, body: { fields: { note: S('host') } } });
  check('fixture: admins/admin1 created (owner bypass)', st === 200, `status ${st}`);

  st = await req('GET', '/reservations', { token: ADMIN });
  check('admin can read reservations', st === 200, `status ${st}`);

  st = await req('POST', `/reservations?documentId=adminblock_${RUN}`, { token: ADMIN, body: reservationBody('blocked', 'admin') });
  check('admin can create a manual block', st === 200, `status ${st}`);

  st = await req('POST', `/reservations?documentId=adminblockx_${RUN}`, { token: USER, body: reservationBody('blocked', 'admin') });
  check('non-admin cannot create a manual block', st === 403, `status ${st}`);

  // ── availability index ─────────────────────────────────────────────────
  st = await req('GET', `/availability/${day}`, {});
  check('availability is publicly readable', st === 404 || st === 200, `status ${st}`);

  st = await req('POST', `/availability?documentId=${day}`, { token: ADMIN, body: { fields: { reservationId: S('x') } } });
  check('admin can claim a day', st === 200, `status ${st}`);

  st = await req('POST', `/availability?documentId=${day}`, { token: USER, body: { fields: { reservationId: S('y') } } });
  check('non-admin cannot claim a day', st === 403, `status ${st}`);

  st = await req('PATCH', `/availability/${day}?updateMask.fieldPaths=reservationId`, { token: ADMIN, body: { fields: { reservationId: S('z') } } });
  check('claimed days cannot be updated (create-only claim)', st === 403, `status ${st}`);

  st = await req('DELETE', `/availability/${day}`, { token: ADMIN });
  check('admin can release a day', st === 200, `status ${st}`);

  // ── push plumbing ──────────────────────────────────────────────────────
  st = await req('POST', `/pushTokens?documentId=tok_${RUN}`, { token: ADMIN, body: { fields: { token: S('t'), ua: S('test') } } });
  check('admin can register a push token', st === 200, `status ${st}`);

  st = await req('POST', `/pushTokens?documentId=tok2_${RUN}`, { token: USER, body: { fields: { token: S('t') } } });
  check('non-admin cannot register a push token', st === 403, `status ${st}`);

  st = await req('POST', `/pushTests?documentId=test_${RUN}`, { token: ADMIN, body: { fields: { sent: { booleanValue: false } } } });
  check('admin can request a test push', st === 200, `status ${st}`);

  st = await req('DELETE', `/availability/2026-07-99`, {});
  check('anonymous cannot delete availability', st === 403, `status ${st}`);

  // ── pricing config (public read, admin write) ──────────────────────────
  st = await req('POST', `/pricing?documentId=config`, { token: ADMIN, body: { fields: { base: I(80) } } });
  check('admin can write the pricing config', st === 200, `status ${st}`);

  st = await req('GET', `/pricing/config`, {});
  check('pricing config is publicly readable', st === 200, `status ${st}`);

  st = await req('PATCH', `/pricing/config?updateMask.fieldPaths=base`, { token: USER, body: { fields: { base: I(999) } } });
  check('non-admin cannot change pricing', st === 403, `status ${st}`);

  // ── rejection email arming: admin sets status + rejectMailState together ──
  st = await req('PATCH', `/reservations/pending_${RUN}?updateMask.fieldPaths=status&updateMask.fieldPaths=rejectMailState`, {
    token: ADMIN, body: { fields: { status: S('rejected'), rejectMailState: S('new') } }
  });
  check('admin can reject with rejectMailState', st === 200, `status ${st}`);

  console.log(`\n${passed} passed, ${failures} failed`);
  process.exitCode = failures === 0 ? 0 : 1;
}

main().catch((err) => {
  console.error('rules test crashed:', err);
  process.exitCode = 1;
});
