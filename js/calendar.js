/**
 * calendar.js — Shared availability calendar module
 * VillaST — San Teodoro, Sardegna
 *
 * Firestore Availability Schema:
 * Collection: "availability"
 * Document ID: "YYYY-MM-DD" (e.g., "2025-07-15")
 * Document data: { type: "blocked" }
 *
 * To block a date: set document "YYYY-MM-DD" with { type: "blocked" }
 * To unblock: delete the document
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
 * Load all blocked dates from Firestore availability collection
 * @param {import("firebase/firestore").Firestore} db
 * @returns {Promise<Set<string>>} Set of YYYY-MM-DD date strings
 */
export async function loadBookedDates(db) {
  const snap = await getDocs(collection(db, 'availability'));
  const blocked = new Set();
  snap.forEach(docSnap => {
    if (docSnap.data().type === 'blocked') {
      blocked.add(docSnap.id);
    }
  });
  return blocked;
}

export async function loadBookedDatesWithMeta(db) {
  const snap = await getDocs(collection(db, 'availability'));
  const meta = new Map();
  snap.forEach(docSnap => {
    const data = docSnap.data();
    if (data.type === 'blocked') {
      meta.set(docSnap.id, { type: 'blocked', reservationId: data.reservationId || null });
    }
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
 * Find the first blocked date strictly between start and end (exclusive).
 * Returns null if no blocked dates exist in the range.
 * @param {Date} start
 * @param {Date} end
 * @param {Set<string>} bookedDates
 * @returns {string|null} YYYY-MM-DD of first blocked date, or null
 */
export function findFirstBlockedInRange(start, end, bookedDates) {
  const current = new Date(start.getTime());
  current.setDate(current.getDate() + 1); // skip start itself
  const endTime = end.getTime();
  while (current.getTime() < endTime) { // strict < so we skip end itself
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
 * Initialize the guest-facing check-in/check-out date pickers
 * Uses Flatpickr (loaded globally on page via CDN).
 * Two-step flow: pick start date → pick end date.
 * @param {HTMLElement} checkInEl
 * @param {HTMLElement} checkOutEl
 * @param {Set<string>} bookedDates — set of blocked YYYY-MM-DD strings
 */
export function initGuestCalendar(checkInEl, checkOutEl, bookedDates) {
  const blockedArray = Array.from(bookedDates);
  const errorEl = document.getElementById('calendar-range-error');

  // --- State machine ---
  let state = 'pick_start'; // 'pick_start' | 'pick_end'
  let selectedStart = null; // Date object

  // --- Conflict modal (created once, reused) ---
  const modal = createConflictModal();

  // --- Hint / aria-live ---
  const hintEl = document.createElement('p');
  hintEl.id = 'calendar-step-hint';
  hintEl.className = 'calendar-step-hint';
  hintEl.setAttribute('aria-live', 'polite');
  hintEl.style.display = 'none';
  checkInEl.parentNode.insertBefore(hintEl, errorEl);

  // --- Reset button (inline next to input) ---
  const resetBtn = document.createElement('button');
  resetBtn.type = 'button';
  resetBtn.className = 'calendar-reset-btn';
  resetBtn.innerHTML = '<span class="it">&#10005; Reinserisci</span><span class="en">&#10005; Reset</span>';
  resetBtn.title = 'Reset selection';
  resetBtn.style.display = 'none';
  checkInEl.parentNode.insertBefore(resetBtn, hintEl);

  function showHint(textIT, textEN) {
    const isEN = document.body.classList.contains('lang-en');
    hintEl.textContent = isEN ? textEN : textIT;
    hintEl.style.display = '';
  }

  function hideHint() {
    hintEl.style.display = 'none';
  }

  function commitDates(start, end) {
    checkInEl.value = formatDateISO(start);
    checkOutEl.value = formatDateISO(end);
  }

  function clearDates() {
    checkInEl.value = '';
    checkOutEl.value = '';
    selectedStart = null;
  }

  function resetToStart() {
    clearDates();
    state = 'pick_start';
    hideHint();
    if (errorEl) errorEl.style.display = 'none';
    resetBtn.style.display = 'none';
  }

  // Reset button handler
  resetBtn.addEventListener('click', resetToStart);

  // --- Flatpickr (single mode, state-driven) ---
  const fp = flatpickr(checkInEl, {
    mode: 'single',
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
      const date = selectedDates[0];
      if (!date) return;

      if (state === 'pick_start') {
        selectedStart = date;
        state = 'pick_end';
        commitDates(selectedStart, null);
        showHint('Ora seleziona la data di fine', 'Now select the end date');
        resetBtn.style.display = '';
        // Reopen calendar for end-date pick
        fp.open();
        fp.setDate(null, false);
      }
      // pick_end is handled in onClose (after calendar closes)
    },

    onClose: () => {
      if (state !== 'pick_end') return;
      // Get whatever date is currently selected
      const selected = fp.selectedDates;
      if (!selected || !selected[0] || !selectedStart) return;

      const endDate = selected[0];
      // Ignore if same as start
      if (formatDateISO(endDate) === formatDateISO(selectedStart)) {
        fp.setDate(null, false);
        return;
      }

      if (rangeHasBlockedDate(selectedStart, endDate)) {
        // Conflict — find first blocked date and show modal
        const conflictDate = findFirstBlockedInRange(selectedStart, endDate, bookedDates);
        const msgIT = conflictDate
          ? `La data ${conflictDate} è già prenotata. Scegli una data di fine diversa.`
          : 'Il periodo selezionato contiene date non disponibili.';
        const msgEN = conflictDate
          ? `The date ${conflictDate} is already reserved. Pick a different end date.`
          : 'The selected period contains unavailable dates.';
        const isEN = document.body.classList.contains('lang-en');
        modal.open(isEN ? msgEN : msgIT, () => {
          // "Reset dates" button in modal
          resetToStart();
        });
        // Clear the end date but keep start, stay in pick_end
        fp.setDate(null, false);
        // Re-open calendar so user can immediately pick another end date
        setTimeout(() => fp.open(), 100);
      } else {
        // Clean range — commit and reset
        commitDates(selectedStart, endDate);
        if (errorEl) errorEl.style.display = 'none';
        hideHint();
        state = 'pick_start';
        selectedStart = null;
        resetBtn.style.display = 'none';
        fp.setDate(null, false);
      }
    }
  });

  function rangeHasBlockedDate(start, end) {
    const current = new Date(start.getTime());
    const endTime = end.getTime();
    while (current.getTime() <= endTime) {
      if (bookedDates.has(formatDateISO(current))) return true;
      current.setDate(current.getDate() + 1);
    }
    return false;
  }

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
 * Check if any date in the requested range conflicts with blocked dates
 * NOTE: This is a UX-only check. Firestore rules do NOT enforce availability.
 * The admin must confirm/reject conflicting requests manually.
 * @param {string} checkIn — YYYY-MM-DD
 * @param {string} checkOut — YYYY-MM-DD
 * @param {Set<string>} bookedDates
 * @returns {boolean} true if conflict exists
 */
export function dateRangeHasConflict(checkIn, checkOut, bookedDates) {
  if (!checkIn || !checkOut) return false;
  const start = new Date(checkIn + 'T00:00:00');
  const end = new Date(checkOut + 'T00:00:00');
  const current = new Date(start);
  while (current <= end) {
    if (bookedDates.has(formatDateISO(current))) return true;
    current.setDate(current.getDate() + 1);
  }
  return false;
}

/**
 * Save the admin's blocked date selections to Firestore
 * Diffs the new selection against the original to minimize writes
 * @param {import("firebase/firestore").Firestore} db
 * @param {Set<string>} originalBlocked — set of previously blocked dates
 * @param {Date[]} newSelected — array of Date objects from Flatpickr
 * @returns {Promise<void>}
 */
export async function saveAvailability(db, originalBlocked, newSelected) {
  const newBlockedSet = new Set(newSelected.map(formatDateISO));

  const toAdd = [...newBlockedSet].filter(d => !originalBlocked.has(d));
  const toRemove = [...originalBlocked].filter(d => !newBlockedSet.has(d));

  const writes = [
    ...toAdd.map(dateStr => setDoc(doc(db, 'availability', dateStr), { type: 'blocked' })),
    ...toRemove.map(dateStr => deleteDoc(doc(db, 'availability', dateStr)))
  ];

  await Promise.all(writes);
}
