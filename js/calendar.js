/**
 * calendar.js — Shared availability calendar module
 * VillaST — San Teodoro, Sardegna
 *
 * Single source of truth: the `reservations` collection.
 * The `availability` collection is a derived per-day occupancy index:
 *   - doc id  : "YYYY-MM-DD"
 *   - data    : { reservationId: <id of the occupying reservation> }
 * The presence of an `availability` doc means that day is occupied.
 * It is kept in sync with `reservations` by the admin flows (confirm,
 * reject, delete, manual block) and is public-readable so the guest
 * calendar can paint blocked days without exposing guest PII.
 */

import { collection, getDocs, doc, setDoc, deleteDoc } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";

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
 * Load all occupied dates from Firestore `availability` collection.
 * Any document in the collection represents a blocked day.
 * @param {import("firebase/firestore").Firestore} db
 * @returns {Promise<Set<string>>} Set of YYYY-MM-DD date strings
 */
export async function loadBookedDates(db) {
  const snap = await getDocs(collection(db, 'availability'));
  const blocked = new Set();
  snap.forEach(docSnap => blocked.add(docSnap.id));
  return blocked;
}

/**
 * Load occupied dates with reservationId metadata (for admin tooltips).
 * @param {import("firebase/firestore").Firestore} db
 * @returns {Promise<Map<string,object>>} Map of dateStr -> { reservationId }
 */
export async function loadBookedDatesWithMeta(db) {
  const snap = await getDocs(collection(db, 'availability'));
  const meta = new Map();
  snap.forEach(docSnap => {
    meta.set(docSnap.id, { reservationId: docSnap.data().reservationId || null });
  });
  return meta;
}

/**
 * Decorate every visible day cell in a Flatpickr instance with semantic CSS classes.
 * Called from onDayCreate so classes refresh on each month/year change.
 *
 * @param {object} fp — Flatpickr instance
 * @param {Set<string>|Map<string,object>} bookedDates — Set of blocked dates, or Map with meta
 * @param {object} [opts]
 * @param {boolean} [opts.showTooltips=false] — Add title attribute with reservation info (admin)
 */
export function decorateDays(fp, bookedDates, opts = {}) {
  const dayElements = fp.calendarContainer.querySelectorAll(
    '.flatpickr-day:not(.prevMonthDay):not(.nextMonthDay):not(.flatpickr-otherMonth)'
  );

  dayElements.forEach(dayEl => {
    // Parse the date from aria-label (Flatpickr stores "Month Day, YYYY")
    const ariaLabel = dayEl.getAttribute('aria-label');
    if (!ariaLabel) return;

    const parsed = new Date(ariaLabel + 'T00:00:00');
    if (isNaN(parsed.getTime())) return;

    const dateStr = formatDateISO(parsed);
    const isBlocked = bookedDates.has(dateStr);

    // Reset classes (except Flatpickr's own)
    dayEl.classList.remove('is-reserved', 'is-available', 'is-today');

    // Today
    const today = new Date();
    if (dateStr === formatDateISO(today)) {
      dayEl.classList.add('is-today');
    }

    if (isBlocked) {
      dayEl.classList.add('is-reserved');
    } else {
      dayEl.classList.add('is-available');
    }

    // Admin: show reservation tooltip on reserved days
    if (opts.showTooltips && isBlocked && bookedDates instanceof Map) {
      const meta = bookedDates.get(dateStr);
      if (meta) {
        const resId = meta.reservationId;
        dayEl.title = resId
          ? `Bloccata — prenotazione #${resId.slice(0, 8)}`
          : 'Bloccata manualmente';
      }
    }
  });
}

/**
 * Create the bilingual calendar legend HTML and append it to a container.
 * @param {HTMLElement} container — element to append the legend to
 */
export function createCalendarLegend(container) {
  if (!container || container.querySelector('.calendar-legend')) return;

  const legend = document.createElement('div');
  legend.className = 'calendar-legend';
  legend.innerHTML = `
    <span class="calendar-legend__item">
      <span class="calendar-legend__swatch calendar-legend__swatch--available"></span>
      <span class="it">Disponibile</span><span class="en">Available</span>
    </span>
    <span class="calendar-legend__item">
      <span class="calendar-legend__swatch calendar-legend__swatch--reserved"></span>
      <span class="it">Non disponibile</span><span class="en">Reserved</span>
    </span>
    <span class="calendar-legend__item">
      <span class="calendar-legend__swatch calendar-legend__swatch--selected"></span>
      <span class="it">Selezionato</span><span class="en">Selected</span>
    </span>
  `;
  container.appendChild(legend);
}

/**
 * Check whether any day in the inclusive range [start, end] is blocked.
 * Used for guest range validation (catches partial overlaps).
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
 * Returns null if no blocked dates exist in the range.
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
 * Create and show the conflict modal.
 * Follows the same pattern as the lightbox in app.js.
 * Returns a function closeConflictModal to dismiss it.
 */
function createConflictModal() {
  // Build modal DOM
  const overlay = document.createElement('div');
  overlay.id = 'calendar-conflict-modal';
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');
  overlay.setAttribute('aria-label', 'Date conflict');
  overlay.innerHTML = `
    <div class="ccm__overlay"></div>
    <div class="ccm__dialog">
      <button class="ccm__close" aria-label="Close">&times;</button>
      <div class="ccm__body">
        <p class="ccm__icon">&#9888;</p>
        <p class="ccm__message"></p>
        <div class="ccm__actions">
          <button class="ccm__btn-reset btn btn--primary" type="button">
            <span class="it">Reimposta date</span>
            <span class="en">Reset dates</span>
          </button>
          <button class="ccm__btn-close btn btn--outline" type="button" style="border-color:var(--neutral-300); color:var(--neutral-700);">
            OK
          </button>
        </div>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);

  // Inject scoped styles (once)
  if (!document.getElementById('ccm-styles')) {
    const style = document.createElement('style');
    style.id = 'ccm-styles';
    style.textContent = `
      #calendar-conflict-modal {
        display: none;
        position: fixed;
        inset: 0;
        z-index: var(--z-modal, 800);
        align-items: center;
        justify-content: center;
      }
      #calendar-conflict-modal.ccm--open { display: flex; }
      .ccm__overlay {
        position: absolute;
        inset: 0;
        background: rgba(0,0,0,0.45);
      }
      .ccm__dialog {
        position: relative;
        z-index: 1;
        background: var(--color-white, #fff);
        border-radius: var(--radius-lg, 12px);
        box-shadow: var(--shadow-xl, 0 24px 64px rgba(0,0,0,0.18));
        max-width: 400px;
        width: 90%;
        padding: var(--space-48, 3rem) var(--space-32, 2rem) var(--space-32, 2rem);
        text-align: center;
      }
      .ccm__close {
        position: absolute;
        top: var(--space-12, 0.75rem);
        right: var(--space-16, 1rem);
        background: none;
        border: none;
        font-size: 1.6rem;
        color: var(--neutral-500, #8a8a8a);
        cursor: pointer;
        line-height: 1;
        padding: var(--space-4, 0.25rem);
        border-radius: var(--radius-sm, 4px);
        transition: color var(--duration-fast, 150ms) var(--ease-out, cubic-bezier(0.16,1,0.3,1));
      }
      .ccm__close:hover { color: var(--neutral-800, #2d2d2d); }
      .ccm__icon {
        font-size: 2.5rem;
        margin-bottom: var(--space-16, 1rem);
        color: var(--color-terra, #C1694F);
        line-height: 1;
      }
      .ccm__message {
        font-size: 1rem;
        line-height: 1.6;
        color: var(--neutral-700, #4a4a4a);
        margin-bottom: var(--space-32, 2rem);
      }
      .ccm__actions {
        display: flex;
        gap: var(--space-12, 0.75rem);
        justify-content: center;
      }
      .ccm__btn-reset,
      .ccm__btn-close {
        min-width: 120px;
      }
    `;
    document.head.appendChild(style);
  }

  const messageEl = overlay.querySelector('.ccm__message');
  const closeBtn = overlay.querySelector('.ccm__close');
  const overlayBg = overlay.querySelector('.ccm__overlay');
  const btnReset = overlay.querySelector('.ccm__btn-reset');
  const btnClose = overlay.querySelector('.ccm__btn-close');

  let onReset = null;

  function open(message, resetCallback) {
    messageEl.textContent = message;
    onReset = typeof resetCallback === 'function' ? resetCallback : null;
    overlay.classList.add('ccm--open');
    document.body.style.overflow = 'hidden';
    closeBtn.focus();
  }

  function close() {
    overlay.classList.remove('ccm--open');
    document.body.style.overflow = '';
  }

  closeBtn.addEventListener('click', close);
  overlayBg.addEventListener('click', close);
  btnClose.addEventListener('click', close);
  btnReset.addEventListener('click', () => {
    close();
    if (onReset) onReset();
  });

  // Esc to close
  const escHandler = (e) => {
    if (e.key === 'Escape' && overlay.classList.contains('ccm--open')) {
      close();
      e.stopPropagation();
    }
  };
  document.addEventListener('keydown', escHandler);

  return { open, close };
}

/**
 * Initialize the guest-facing check-in/check-out date picker.
 * Uses a single Flatpickr instance in `range` mode attached to the check-in
 * input; the check-out value is written to the hidden check-out input.
 * Blocked dates are disabled and any selected range that spans a blocked
 * date (partial overlap) is rejected with the conflict modal.
 *
 * @param {HTMLElement} checkInEl — visible read-only text input
 * @param {HTMLElement} checkOutEl — hidden input receiving the end date
 * @param {Set<string>} bookedDates — set of blocked YYYY-MM-DD strings
 */
export function initGuestCalendar(checkInEl, checkOutEl, bookedDates) {
  const blockedArray = Array.from(bookedDates);
  const errorEl = document.getElementById('calendar-range-error');
  const modal = createConflictModal();

  function isEN() {
    return document.body.classList.contains('lang-en');
  }

  const fp = flatpickr(checkInEl, {
    mode: 'range',
    dateFormat: 'Y-m-d',
    minDate: 'today',
    disable: blockedArray,
    allowInput: false,
    clickOpens: true,
    locale: { firstDayOfWeek: 1 },

    onDayCreate: function (selectedDates, dateStr, instance) {
      decorateDays(instance, bookedDates);
    },

    onChange: (selectedDates) => {
      if (!selectedDates || selectedDates.length === 0) {
        checkOutEl.value = '';
        return;
      }

      const start = selectedDates[0];
      const end = selectedDates[1];

      if (!end) {
        // Only the start date has been picked so far.
        checkOutEl.value = '';
        if (errorEl) errorEl.style.display = 'none';
        return;
      }

      // Full range picked — reject if any blocked date falls inside it.
      if (rangeHasBlockedDate(start, end, bookedDates)) {
        const conflictDate = findFirstBlockedInRange(start, end, bookedDates);
        const msg = conflictDate
          ? (isEN()
              ? `The date ${conflictDate} is already reserved. Pick different dates.`
              : `La data ${conflictDate} è già prenotata. Scegli date diverse.`)
          : (isEN()
              ? 'The selected period contains unavailable dates.'
              : 'Il periodo selezionato contiene date non disponibili.');
        modal.open(msg, () => {
          fp.clear();
          checkOutEl.value = '';
          if (errorEl) errorEl.style.display = 'none';
        });
        // Keep nothing selected so the user can immediately pick again.
        fp.clear();
        return;
      }

      // Valid range — flatpickr already wrote "start to end" into checkInEl;
      // persist the end date to the hidden check-out input for submission.
      checkOutEl.value = formatDateISO(end);
      if (errorEl) errorEl.style.display = 'none';
    }
  });

  // Append bilingual legend below the calendar
  const calendarWrapper = checkInEl.closest('.form-group') || checkInEl.parentElement;
  if (calendarWrapper) {
    createCalendarLegend(calendarWrapper);
  }

  return { checkIn: fp, checkOut: null };
}

/**
 * Initialize the admin calendar (inline, multi-select for blocking dates)
 * @param {HTMLElement} el — container element for inline calendar
 * @param {Set<string>} bookedDates — initial blocked dates
 * @param {function(Date[]): void} onChange — called when selection changes
 * @param {object} extraOptions - additional Flatpickr options
 * @returns {object} Flatpickr instance
 */
export function initAdminCalendar(el, bookedDates, onChange, extraOptions = {}) {
  const preselected = Array.from(bookedDates);
  // Use meta Map for tooltips if available, otherwise fall back to plain Set
  const metaMap = extraOptions._bookedDatesMeta || null;

  return flatpickr(el, {
    mode: 'multiple',
    inline: true,
    dateFormat: 'Y-m-d',
    defaultDate: preselected,
    locale: { firstDayOfWeek: 1 },
    onDayCreate: function (selectedDates, dateStr, instance) {
      decorateDays(instance, metaMap || bookedDates, { showTooltips: !!metaMap });
    },
    onChange: (selectedDates) => {
      if (typeof onChange === 'function') {
        onChange(selectedDates);
      }
    },
    ...extraOptions
  });
}

/**
 * Check if any date in the requested range conflicts with blocked dates.
 * The range is inclusive of check-out (matches the per-day occupancy model).
 * @param {string} checkIn — YYYY-MM-DD
 * @param {string} checkOut — YYYY-MM-DD
 * @param {Set<string>} bookedDates
 * @returns {boolean} true if conflict exists
 */
export function dateRangeHasConflict(checkIn, checkOut, bookedDates) {
  if (!checkIn || !checkOut) return false;
  const start = new Date(checkIn + 'T00:00:00');
  const end = new Date(checkOut + 'T00:00:00');
  return rangeHasBlockedDate(start, end, bookedDates);
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
