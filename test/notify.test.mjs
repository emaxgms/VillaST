/**
 * test/notify.test.mjs — notifier email rendering (no npm dependencies).
 *
 * Run: node test/notify.test.mjs
 * Evaluates tools/apps-script/notify.gs inside a vm sandbox (the mail builders
 * are pure — no Apps Script globals needed to render them) and checks the
 * confirmation and rejection emails in both languages, including the quote
 * row. Exits non-zero on the first failing check set.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const src = readFileSync(new URL('../tools/apps-script/notify.gs', import.meta.url), 'utf8');
const sandbox = { console, Date };
vm.createContext(sandbox);
const mail = vm.runInContext(
  src + '\n;({ mailSubject_, mailHtml_, rejectMailSubject_, rejectMailHtml_ });',
  sandbox
);

const booking = { name: 'Mario Rossi', checkIn: '2027-08-12', checkOut: '2027-08-19', guests: 2, lang: 'it' };

let passed = 0;

function check(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ok   ${name}`);
  } catch (err) {
    console.error(`  FAIL ${name} — ${err.message}`);
    process.exitCode = 1;
  }
}

check('confirmation email, IT + EN, no quote row when quoteTotal is absent', () => {
  assert.ok(mail.mailSubject_(false, booking).includes('Ciao Mario'));
  assert.ok(mail.mailSubject_(false, booking).includes('confermata'));

  const it = mail.mailHtml_(false, booking);
  assert.ok(it.includes('lang="it"'));
  assert.ok(it.includes('Mario'));
  assert.ok(it.includes('12/08 → 19/08'));
  assert.ok(!it.includes('Totale indicativo'));
  assert.ok(!it.includes('undefined'));

  assert.ok(mail.mailSubject_(true, booking).includes('Hi Mario'));
  const en = mail.mailHtml_(true, booking);
  assert.ok(en.includes('lang="en"'));
  assert.ok(!en.includes('Totale indicativo'));
  assert.ok(!en.includes('undefined'));
});

check('confirmation email shows the quoted total when present', () => {
  const it = mail.mailHtml_(false, { ...booking, quoteTotal: 1750 });
  assert.ok(it.includes('Totale indicativo'));
  assert.ok(it.includes('€1750'));

  const en = mail.mailHtml_(true, { ...booking, quoteTotal: 1750 });
  assert.ok(en.includes('Indicative total'));
  assert.ok(en.includes('€1750'));
});

check('rejection email, IT + EN, no payment block, no quote row', () => {
  const itSub = mail.rejectMailSubject_(false, booking);
  assert.ok(itSub.includes('Ciao Mario'));
  assert.ok(itSub.includes('non sono disponibili'));
  assert.ok(itSub.includes('12/08 → 19/08'));

  const it = mail.rejectMailHtml_(false, { ...booking, quoteTotal: 1750 });
  assert.ok(it.includes('lang="it"'));
  assert.ok(it.includes('12/08 → 19/08'));
  assert.ok(it.includes('date alternative'));
  assert.ok(!it.includes('IBAN'));
  assert.ok(!it.includes('Totale indicativo'));
  assert.ok(!it.includes('undefined'));

  const enSub = mail.rejectMailSubject_(true, booking);
  assert.ok(enSub.includes('Hi Mario'));
  assert.ok(enSub.includes('not available'));

  const en = mail.rejectMailHtml_(true, booking);
  assert.ok(en.includes('lang="en"'));
  assert.ok(en.includes('alternative dates'));
  assert.ok(!en.includes('undefined'));
});

check('missing name and dates degrade without throwing', () => {
  const weird = { checkIn: '', checkOut: '', lang: 'it' };
  const it = mail.rejectMailHtml_(false, weird);
  assert.ok(it.includes('Date richieste'));
  assert.ok(mail.rejectMailSubject_(false, weird).length > 0);
  assert.ok(mail.mailHtml_(false, weird).length > 0);
});

console.log(`\n${passed} notify check(s) passed`);
