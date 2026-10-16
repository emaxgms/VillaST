/**
 * pricing.js — Price model: seasons, date overrides and quotes (NO firebase
 * imports, node-testable — same pattern as day-state.js).
 * VillaST — San Teodoro, Sardegna
 *
 * Config doc: `pricing/config` in Firestore (public read / admin write):
 *   {
 *     base: <int EUR/night>,                        // fallback when no season matches
 *     seasons: { low|mid|high: { price, minNights } },
 *     overrides: [{ id, from, to, price, label? }]  // `to` empty or == from → single date
 *   }
 *
 * Season windows are fixed — the "known" seasonality the site publishes:
 *   low  = Oct–Apr · mid = May, Jun, Sep · high = Jul, Aug
 * Precedence per night: override > season > base.
 * Charged nights are [checkIn, checkOut) — the check-out day is not charged.
 */

import { getDatesInRange } from './day-state.js';

/** Values the static HTML publishes; also the fallback when the doc is absent. */
export const DEFAULT_PRICING = {
  base: 80,
  seasons: {
    low: { price: 80, minNights: 2 },
    mid: { price: 120, minNights: 3 },
    high: { price: 180, minNights: 5 }
  },
  overrides: []
};

// Month index (Jan=0): Oct–Apr low, May/Jun/Sep mid, Jul/Aug high.
const SEASON_OF_MONTH = ['low', 'low', 'low', 'low', 'mid', 'mid', 'high', 'high', 'mid', 'low', 'low', 'low'];

const isIso = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ''));
const posInt = (v, fallback) => {
  const n = Math.round(Number(v));
  return Number.isFinite(n) && n > 0 ? n : fallback;
};

/** Season key for one ISO date. */
export function seasonOf(iso) {
  return SEASON_OF_MONTH[Number(String(iso).slice(5, 7)) - 1] || 'low';
}

/** Tolerant read of the Firestore doc: fills gaps from DEFAULT_PRICING, drops malformed overrides. */
export function normalizePricing(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const seasons = {};
  for (const key of ['low', 'mid', 'high']) {
    const s = (src.seasons && src.seasons[key]) || {};
    seasons[key] = {
      price: posInt(s.price, DEFAULT_PRICING.seasons[key].price),
      minNights: posInt(s.minNights, DEFAULT_PRICING.seasons[key].minNights)
    };
  }
  const overrides = (Array.isArray(src.overrides) ? src.overrides : [])
    .filter((o) => o && isIso(o.from) && posInt(o.price, 0))
    .map((o) => ({
      id: o.id ? String(o.id) : undefined,
      from: o.from,
      to: isIso(o.to) && o.to >= o.from ? o.to : o.from,
      price: posInt(o.price, 0),
      ...(o.label ? { label: String(o.label) } : {})
    }));
  return { base: posInt(src.base, DEFAULT_PRICING.base), seasons, overrides };
}

/**
 * Nightly price for one night (the night STARTING on `iso`).
 * Most specific override wins (shortest range; ties → first in the list);
 * then the season price; then base.
 */
export function nightPrice(cfg, iso) {
  let best = null;
  for (const o of cfg.overrides) {
    if (o.from <= iso && iso <= o.to) {
      const span = (Date.parse(o.to) - Date.parse(o.from)) / 86400000;
      if (!best || span < best.span) best = { price: o.price, span };
    }
  }
  if (best) return best.price;
  const season = cfg.seasons[seasonOf(iso)];
  return season && season.price ? season.price : cfg.base;
}

/**
 * Quote a stay. Nights = [checkIn, checkOut); `minNights` is the strictest
 * season minimum across the stay; `belowMin` is a notice, never a block.
 */
export function quote(cfg, checkIn, checkOut) {
  const days = getDatesInRange(checkIn, checkOut);
  const nights = days.length > 1 ? days.slice(0, -1) : [];
  let total = 0;
  let minNights = 0;
  for (const d of nights) {
    total += nightPrice(cfg, d);
    const s = cfg.seasons[seasonOf(d)];
    if (s && s.minNights > minNights) minNights = s.minNights;
  }
  return { nights: nights.length, total, minNights, belowMin: nights.length > 0 && nights.length < minNights };
}

/** Cheapest advertised nightly rate ("from €X") across seasons and base. */
export function cheapestNight(cfg) {
  return Math.min(cfg.base, ...['low', 'mid', 'high'].map((k) => cfg.seasons[k].price));
}

/**
 * Homepage: write the config into the pricing cards ([data-season]) and the
 * sticky-bar "from" price. The min-nights text is updated in both languages;
 * a generated /en/ page only carries its own language's spans (optional).
 */
export function applyHomepagePricing(cfg, root = document) {
  for (const key of ['low', 'mid', 'high']) {
    const card = root.querySelector(`[data-season="${key}"]`);
    if (!card) continue;
    const season = cfg.seasons[key];
    const amount = card.querySelector('.pricing-price .amount');
    if (amount) amount.textContent = String(season.price);
    const min = card.querySelector('.pricing-min');
    if (min) {
      const it = min.querySelector('.it');
      if (it) it.textContent = `min. ${season.minNights} notti`;
      const en = min.querySelector('.en');
      if (en) en.textContent = `min. ${season.minNights} nights`;
    }
  }
  const bar = root.getElementById ? root.getElementById('booking-bar') : null;
  const barStrong = bar && bar.querySelector('strong');
  if (barStrong) barStrong.textContent = `€${cheapestNight(cfg)}`;
}
