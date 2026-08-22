/**
 * day-state.js — Pure per-day state model (NO imports, node-testable)
 * VillaST — San Teodoro, Sardegna
 *
 * Single source of truth: the `reservations` collection.
 * The `availability` collection is a derived per-day occupancy index:
 *   - doc id  : "YYYY-MM-DD"
 *   - data    : { reservationId: <id of the occupying reservation> }
 *
 * Only `confirmed` and `blocked` reservations occupy dates; `pending`
 * requests never occupy but overlay a pending count on the days they touch.
 *
 * All helpers here are dependency-free so they can be imported by both
 * js/calendar.js and js/admin.js and unit-tested directly in Node.
 */

/**
 * Format a Date object to YYYY-MM-DD string (local timezone safe)
 * @param {Date} date
 * @returns {string}
 */
export function formatDateISO(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/**
 * Add (or subtract) days to a YYYY-MM-DD string, returning YYYY-MM-DD.
 * @param {string} isoStr
 * @param {number} n
 * @returns {string}
 */
export function addDays(isoStr, n) {
  const d = new Date(isoStr + 'T00:00:00');
  d.setDate(d.getDate() + n);
  return formatDateISO(d);
}

/**
 * Expand an inclusive [checkIn, checkOut] range into its list of day strings.
 * @param {string} checkIn — YYYY-MM-DD
 * @param {string} checkOut — YYYY-MM-DD
 * @returns {string[]}
 */
export function getDatesInRange(checkIn, checkOut) {
  const dates = [];
  if (!checkIn || !checkOut) return dates;
  const current = new Date(checkIn + 'T00:00:00');
  const end = new Date(checkOut + 'T00:00:00');
  while (current <= end) {
    dates.push(formatDateISO(current));
    current.setDate(current.getDate() + 1);
  }
  return dates;
}

/**
 * Group a set of dates into contiguous [checkIn, checkOut] ranges.
 * @param {Set<string>|string[]} dateSet — YYYY-MM-DD strings
 * @returns {{checkIn:string, checkOut:string}[]}
 */
export function groupContiguousDates(dateSet) {
  const sorted = [...dateSet].sort();
  const ranges = [];
  let start = null, prev = null;
  for (const d of sorted) {
    if (start === null) { start = d; prev = d; continue; }
    if (d === addDays(prev, 1)) { prev = d; }
    else { ranges.push({ checkIn: start, checkOut: prev }); start = d; prev = d; }
  }
  if (start !== null) ranges.push({ checkIn: start, checkOut: prev });
  return ranges;
}

/**
 * Check whether any day in the inclusive range [start, end] is blocked.
 * @param {Date} start
 * @param {Date} end
 * @param {Set<string>} bookedDates
 * @returns {boolean}
 */
export function rangeHasBlockedDate(start, end, bookedDates) {
  const current = new Date(start.getTime());
  const endTime = end.getTime();
  while (current.getTime() <= endTime) {
    if (bookedDates.has(formatDateISO(current))) return true;
    current.setDate(current.getDate() + 1);
  }
  return false;
}

/**
 * Find the first blocked date in the inclusive range [start, end].
 * @param {Date} start
 * @param {Date} end
 * @param {Set<string>} bookedDates
 * @returns {string|null} YYYY-MM-DD of first blocked date, or null
 */
export function findFirstBlockedInRange(start, end, bookedDates) {
  const current = new Date(start.getTime());
  const endTime = end.getTime();
  while (current.getTime() <= endTime) {
    const iso = formatDateISO(current);
    if (bookedDates.has(iso)) return iso;
    current.setDate(current.getDate() + 1);
  }
  return null;
}

/**
 * Build a FRESH per-day state map for the admin calendar.
 * Computed from scratch on every call so colors always reflect the latest
 * reservations/availability snapshots (no stale enrichment).
 *
 * @param {Array<{id:string, data:()=>object}>} reservationsDocs
 * @param {Array<{id:string, data:()=>object}>} availabilityDocs
 * @returns {Map<string,{source:string,status:string,reservationId:string|null,name:string,guests:number,checkIn:string|null,checkOut:string|null,pendingCount:number}>}
 *   key: YYYY-MM-DD.
 *   - Occupied days (availability doc): source/status/reservationId/name/guests
 *     from the owning reservation ('admin'+'blocked' → manual block, else guest confirmed).
 *   - Each pending request adds +1 to pendingCount on every day it touches;
 *     days covered ONLY by pending requests get a {status:'pending'} placeholder
 *     entry so the calendar can paint the is-pending overlay on free days.
 *   - Days with no reservation at all are absent from the map (free).
 */
export function buildAdminDayState(reservationsDocs, availabilityDocs) {
  const reservationById = new Map(reservationsDocs.map(ds => [ds.id, ds.data()]));
  const state = new Map();

  // Occupancy comes from the `availability` index (the claim-protected truth).
  availabilityDocs.forEach(ds => {
    const dateStr = ds.id;
    const resId = ds.data().reservationId || null;
    const res = resId ? reservationById.get(resId) : null;
    state.set(dateStr, {
      source: res && res.source ? res.source : 'guest',
      // Any availability doc is occupied; a reservation marked blocked is a
      // manual admin block, anything else is treated as a guest confirmation.
      status: res && res.status === 'blocked' ? 'blocked' : 'confirmed',
      reservationId: resId,
      name: res ? (res.name || '') : '',
      guests: res ? (res.guests || 0) : 0,
      checkIn: res ? (res.checkIn || null) : null,
      checkOut: res ? (res.checkOut || null) : null,
      pendingCount: 0,
    });
  });

  // Pending requests never occupy dates; they only overlay a pending count.
  reservationsDocs.forEach(ds => {
    const d = ds.data();
    if (d.status !== 'pending') return;
    getDatesInRange(d.checkIn, d.checkOut).forEach(dateStr => {
      const existing = state.get(dateStr);
      if (existing) {
        existing.pendingCount += 1;
      } else {
        state.set(dateStr, {
          source: 'guest',
          status: 'pending',
          reservationId: ds.id,
          name: d.name || '',
          guests: d.guests || 0,
          checkIn: d.checkIn,
          checkOut: d.checkOut,
          pendingCount: 1,
        });
      }
    });
  });

  return state;
}