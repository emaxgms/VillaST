/**
 * test/pricing.test.mjs — price model checks (no npm dependencies).
 *
 * Run: node test/pricing.test.mjs
 * Covers js/pricing.js: season windows, override precedence (range / single
 * date / specificity), quote math (nights = [checkIn, checkOut), check-out
 * day not charged), min-nights notice, base fallback, malformed-config
 * tolerance. Exits non-zero on the first failing check set.
 */

import assert from 'node:assert/strict';
import {
  DEFAULT_PRICING,
  normalizePricing,
  seasonOf,
  nightPrice,
  quote,
  cheapestNight
} from '../js/pricing.js';

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

const cfg = normalizePricing({
  base: 90,
  seasons: {
    low: { price: 70, minNights: 2 },
    mid: { price: 130, minNights: 3 },
    high: { price: 190, minNights: 5 }
  },
  overrides: [
    { from: '2027-08-10', to: '2027-08-20', price: 250, label: 'Ferragosto' },
    { from: '2027-08-15', to: '2027-08-15', price: 320 }
  ]
});

check('defaults fill every gap', () => {
  const d = normalizePricing({});
  assert.equal(d.base, DEFAULT_PRICING.base);
  assert.equal(d.seasons.low.price, 80);
  assert.equal(d.seasons.mid.minNights, 3);
  assert.equal(d.seasons.high.price, 180);
  assert.deepEqual(d.overrides, []);
});

check('season windows (month boundaries)', () => {
  assert.equal(seasonOf('2027-01-15'), 'low');
  assert.equal(seasonOf('2027-04-30'), 'low');
  assert.equal(seasonOf('2027-05-01'), 'mid');
  assert.equal(seasonOf('2027-06-30'), 'mid');
  assert.equal(seasonOf('2027-07-01'), 'high');
  assert.equal(seasonOf('2027-08-31'), 'high');
  assert.equal(seasonOf('2027-09-15'), 'mid');
  assert.equal(seasonOf('2027-10-01'), 'low');
  assert.equal(seasonOf('2027-12-31'), 'low');
});

check('override beats season; single date beats the range', () => {
  assert.equal(nightPrice(cfg, '2027-08-09'), 190);
  assert.equal(nightPrice(cfg, '2027-08-10'), 250);
  assert.equal(nightPrice(cfg, '2027-08-15'), 320);
  assert.equal(nightPrice(cfg, '2027-08-20'), 250);
  assert.equal(nightPrice(cfg, '2027-08-21'), 190);
});

check('base is the fallback when the season price is missing', () => {
  const bare = { base: 50, seasons: { low: {}, mid: {}, high: {} }, overrides: [] };
  assert.equal(nightPrice(bare, '2027-03-10'), 50);
});

check('quote sums nights in [checkIn, checkOut); check-out day not charged', () => {
  const q = quote(cfg, '2027-03-01', '2027-03-05');
  assert.equal(q.nights, 4);
  assert.equal(q.total, 280);
  assert.equal(q.minNights, 2);
  assert.equal(q.belowMin, false);

  const one = quote(cfg, '2027-03-01', '2027-03-02');
  assert.equal(one.nights, 1);
  assert.equal(one.total, 70);
});

check('quote over Ferragosto: override range + min-nights notice', () => {
  const q = quote(cfg, '2027-08-12', '2027-08-15');
  assert.equal(q.nights, 3);
  assert.equal(q.total, 750);
  assert.equal(q.minNights, 5);
  assert.equal(q.belowMin, true);

  const full = quote(cfg, '2027-08-10', '2027-08-16');
  assert.equal(full.nights, 6);
  assert.equal(full.total, 250 * 5 + 320); // 10-14 @250 + 15 @320
  assert.equal(full.belowMin, false);
});

check('malformed overrides are dropped; empty `to` = single date; to<from collapses', () => {
  const d = normalizePricing({
    overrides: [
      { from: '2027-08-15', price: 300 },
      { from: 'nope', to: '2027-08-20', price: 100 },
      { from: '2027-08-01', to: '2027-08-05', price: 0 },
      { from: '2027-08-01', to: '2027-07-01', price: 90 }
    ]
  });
  assert.equal(d.overrides.length, 2);
  assert.equal(d.overrides[0].to, '2027-08-15');
  assert.equal(d.overrides[1].to, '2027-08-01');
});

check('cheapest night = min across base and seasons', () => {
  assert.equal(cheapestNight(cfg), 70);
  assert.equal(cheapestNight(normalizePricing({})), 80);
});

check('empty or inverted stay yields an empty quote (never negative totals)', () => {
  const zero = quote(cfg, '2027-08-15', '2027-08-15');
  assert.equal(zero.nights, 0);
  assert.equal(zero.total, 0);
  assert.equal(zero.belowMin, false);

  const inverted = quote(cfg, '2027-08-20', '2027-08-15');
  assert.equal(inverted.nights, 0);
  assert.equal(inverted.total, 0);
});

console.log(`\n${passed} pricing check(s) passed`);
