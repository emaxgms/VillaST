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

/**
 * Initialize the guest-facing check-in/check-out date pickers
 * Uses Flatpickr (loaded globally on page via CDN)
 * @param {HTMLElement} checkInEl
 * @param {HTMLElement} checkOutEl
 * @param {Set<string>} bookedDates — set of blocked YYYY-MM-DD strings
 */
export function initGuestCalendar(checkInEl, checkOutEl, bookedDates) {
  const blockedArray = Array.from(bookedDates);

  const syncRangeValues = (selectedDates) => {
    if (selectedDates.length >= 1) {
      checkInEl.value = formatDateISO(selectedDates[0]);
    } else {
      checkInEl.value = '';
    }

    if (selectedDates.length === 2) {
      checkOutEl.value = formatDateISO(selectedDates[1]);
    } else {
      checkOutEl.value = '';
    }
  };

  const rangeInstance = flatpickr(checkInEl, {
    mode: 'range',
    dateFormat: 'Y-m-d',
    minDate: 'today',
    disable: blockedArray,
    allowInput: false,
    locale: { firstDayOfWeek: 1 },
    onReady: (selectedDates) => {
      syncRangeValues(selectedDates);
    },
    onChange: (selectedDates) => {
      syncRangeValues(selectedDates);
    },
    onClose: (selectedDates) => {
      syncRangeValues(selectedDates);
    }
  });

  return { checkIn: rangeInstance, checkOut: null };
}

/**
 * Initialize the admin calendar (inline, multi-select for blocking dates)
 * @param {HTMLElement} el — container element for inline calendar
 * @param {Set<string>} bookedDates — initial blocked dates
 * @param {function(Date[]): void} onChange — called when selection changes
 * @returns {object} Flatpickr instance
 */
export function initAdminCalendar(el, bookedDates, onChange) {
  const preselected = Array.from(bookedDates);

  return flatpickr(el, {
    mode: 'multiple',
    inline: true,
    dateFormat: 'Y-m-d',
    defaultDate: preselected,
    locale: { firstDayOfWeek: 1 },
    onChange: (selectedDates) => {
      if (typeof onChange === 'function') {
        onChange(selectedDates);
      }
    }
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
