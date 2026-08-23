/**
 * admin.js - Admin dashboard logic
 * VillaST - San Teodoro, Sardegna
 *
 * Single source of truth: the `reservations` collection.
 *  - guest requests   : { source: 'guest', status: 'pending' }
 *  - confirmed bookings: { status: 'confirmed' }
 *  - manual blocks    : { source: 'admin', status: 'blocked' }
 *
 * Occupied statuses (dates taken): 'confirmed' and 'blocked'.
 * The `availability` collection is a derived per-day occupancy index that is
 * kept in sync by every mutation below, and is claim-protected by Firestore
 * rules so two concurrent confirms cannot reserve the same day.
 */

import { db, auth } from './firebase-config.js';
import {
  loadBookedDates,
  initAdminCalendar,
  decorateDays,
  formatDateISO,
  addDays,
  getDatesInRange,
  groupContiguousDates,
  buildAdminDayState
} from './calendar.js';
import {
  signInWithEmailAndPassword,
  signOut,
  onAuthStateChanged
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js";
import {
  collection,
  onSnapshot,
  getDoc,
  getDocs,
  doc,
  query,
  orderBy,
  writeBatch,
  serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";

let unsubscribeReservations = null;
let adminCalendarInstance = null;
let allReservations = [];
let adminAvailabilityDocs = [];
// Fresh per-day state map rebuilt on every snapshot/render (never one-shot enriched).
let adminDayState = new Map();

/* ─── helpers ─────────────────────────────────────────────────────────── */

function isOccupiedStatus(status) { return status === 'confirmed' || status === 'blocked'; }

function showEl(el) { if (el) el.style.display = ''; }
function hideEl(el) { if (el) el.style.display = 'none'; }

function showAdminMessage(text, type = 'success') {
  const el = document.getElementById('admin-message');
  if (!el) return;
  el.textContent = text;
  el.className = `admin-msg admin-msg--${type}`;
  el.style.display = 'block';
  setTimeout(() => { el.style.display = 'none'; }, 5000);
}

function showLoginError(msg) {
  const el = document.getElementById('login-error');
  if (!el) return;
  el.textContent = msg;
  el.style.display = 'block';
}

function hideLoginError() {
  const el = document.getElementById('login-error');
  if (el) el.style.display = 'none';
}

function formatDateDisplay(isoStr) {
  if (!isoStr) return '-';
  const [y, m, d] = isoStr.split('-');
  return `${d}/${m}/${y}`;
}

function statusLabel(status) {
  const labels = { pending: 'In attesa', confirmed: 'Confermata', rejected: 'Rifiutata', blocked: 'Bloccata' };
  return labels[status] || status;
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

// Popup draft editor styles live in their own stylesheet, linked at runtime
// so this file stays self-contained (admin.html owns <head> links).
(function ensurePopupStylesheet() {
  if (document.querySelector('link[href="css/admin-popup.css"]')) return;
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = 'css/admin-popup.css';
  document.head.appendChild(link);
})();

// Max guests selectable in the popup draft editor.
const MAX_GUESTS = 4;

/* ─── rendering ───────────────────────────────────────────────────────── */

function renderReservations(docs, filterStatus = '') {
  const tbody = document.getElementById('reservations-tbody');
  if (!tbody) return;

  const allData = docs.map(d => d.data());
  const pendingCount = allData.filter(d => d.status === 'pending').length;
  const confirmedCount = allData.filter(d => d.status === 'confirmed').length;
  const blockedCount = allData.filter(d => d.status === 'blocked').length;
  const pendingChip = document.querySelector('.stat-chip--pending');
  const confirmedChip = document.querySelector('.stat-chip--confirmed');
  const blockedChip = document.querySelector('.stat-chip--blocked');
  if (pendingChip) pendingChip.textContent = `${pendingCount} In attesa`;
  if (confirmedChip) confirmedChip.textContent = `${confirmedCount} Confermate`;
  if (blockedChip) blockedChip.textContent = `${blockedCount} Bloccate`;

  const filtered = filterStatus ? docs.filter(d => d.data().status === filterStatus) : docs;

  if (filtered.length === 0) {
    tbody.innerHTML = `<tr class="empty-row"><td colspan="6">Nessuna prenotazione trovata</td></tr>`;
    return;
  }

  tbody.innerHTML = filtered.map(docSnap => {
    const d = docSnap.data();
    const id = docSnap.id;
    const isManual = d.source === 'admin' && d.status === 'blocked';
    const badgeClass = `badge badge--${d.status}`;
    const rowClass = isManual ? 'tr--admin' : '';

    const guestCell = isManual
      ? `<strong>${escapeHtml(d.name || 'Blocco manuale')}</strong><br><span class="badge badge--admin">Manuale</span>`
      : `<strong>${escapeHtml(d.name || '-')}</strong>`;
    const contactCell = isManual
      ? '-'
      : `<a href="mailto:${escapeHtml(d.email || '')}">${escapeHtml(d.email || '-')}</a><br><small>${escapeHtml(d.phone || '-')}</small>`;

    const actions = [];
    if (!isManual) {
      if (d.status !== 'confirmed') actions.push(`<button class="btn-action btn-confirm" data-id="${id}">Conferma</button>`);
      if (d.status !== 'rejected') actions.push(`<button class="btn-action btn-reject" data-id="${id}">Rifiuta</button>`);
    }
    actions.push(`<button class="btn-action btn-delete" data-id="${id}">Elimina</button>`);

    return `
      <tr data-id="${id}" class="${rowClass}">
        <td data-label="Ospite">${guestCell}</td>
        <td data-label="Contatti">${contactCell}</td>
        <td data-label="Periodo">${formatDateDisplay(d.checkIn)} - ${formatDateDisplay(d.checkOut)}</td>
        <td data-label="Ospiti">${d.guests || '-'}</td>
        <td data-label="Stato"><span class="${badgeClass}">${statusLabel(d.status)}</span></td>
        <td data-label="Azioni" class="action-cell">${actions.join('')}</td>
      </tr>`;
  }).join('');

  tbody.querySelectorAll('.btn-confirm').forEach(btn => {
    btn.addEventListener('click', () => confirmReservation(btn.dataset.id));
  });
  tbody.querySelectorAll('.btn-reject').forEach(btn => {
    btn.addEventListener('click', () => rejectReservation(btn.dataset.id));
  });
  tbody.querySelectorAll('.btn-delete').forEach(btn => {
    btn.addEventListener('click', () => deleteReservation(btn.dataset.id));
  });
}

/* ─── mutations (all keep `availability` in sync) ─────────────────────── */

async function confirmReservation(id) {
  try {
    const resRef = doc(db, 'reservations', id);
    const snap = await getDoc(resRef);
    if (!snap.exists()) { showAdminMessage('Prenotazione non trovata.', 'error'); return; }

    const data = snap.data();
    if (data.status === 'confirmed') { showAdminMessage('Già confermata.', 'success'); return; }
    const dates = getDatesInRange(data.checkIn, data.checkOut);
    if (dates.length === 0) { showAdminMessage('Date non valide.', 'error'); return; }

    // Overlap check against persisted occupancy (fresh read, not UI state).
    const booked = await loadBookedDates(db);
    const conflict = dates.some(d => booked.has(d));
    if (conflict) {
      showAdminMessage('Alcune date risultano già occupate. Impossibile confermare.', 'error');
      return;
    }

    // Atomic claim + status update. If another confirm claimed any day in the
    // meantime, the create-only rule fails the whole batch.
    const batch = writeBatch(db);
    dates.forEach(d => batch.set(doc(db, 'availability', d), { reservationId: id }));
    batch.update(resRef, { status: 'confirmed' });
    await batch.commit();
    showAdminMessage('Prenotazione confermata.', 'success');
  } catch (err) {
    console.error('Confirm error:', err);
    showAdminMessage('Impossibile confermare: alcune date sono già occupate.', 'error');
  }
}

async function rejectReservation(id) {
  try {
    const resRef = doc(db, 'reservations', id);
    const snap = await getDoc(resRef);
    if (!snap.exists()) { showAdminMessage('Prenotazione non trovata.', 'error'); return; }

    const data = snap.data();
    const dates = getDatesInRange(data.checkIn, data.checkOut);

    const batch = writeBatch(db);
    if (data.status === 'confirmed') {
      dates.forEach(d => batch.delete(doc(db, 'availability', d)));
    }
    batch.update(resRef, { status: 'rejected' });
    await batch.commit();
    showAdminMessage('Prenotazione rifiutata.', 'success');
  } catch (err) {
    console.error('Reject error:', err);
    showAdminMessage('Errore durante l\'aggiornamento.', 'error');
  }
}

async function deleteReservation(id) {
  if (!confirm('Eliminare questa prenotazione?')) return;
  try {
    const resRef = doc(db, 'reservations', id);
    const snap = await getDoc(resRef);
    if (!snap.exists()) { showAdminMessage('Prenotazione non trovata.', 'error'); return; }

    const data = snap.data();
    const batch = writeBatch(db);
    if (isOccupiedStatus(data.status)) {
      getDatesInRange(data.checkIn, data.checkOut).forEach(d => batch.delete(doc(db, 'availability', d)));
    }
    batch.delete(resRef);
    await batch.commit();
    showAdminMessage('Prenotazione eliminata.', 'success');
  } catch (err) {
    console.error('Delete error:', err);
    showAdminMessage('Errore eliminazione.', 'error');
  }
}

/* ─── listeners ───────────────────────────────────────────────────────── */

function startReservationsListener() {
  const q = query(collection(db, 'reservations'), orderBy('createdAt', 'desc'));
  const filterSelect = document.getElementById('filter-status');

  unsubscribeReservations = onSnapshot(q, async (snapshot) => {
    allReservations = snapshot.docs;
    renderReservations(allReservations, filterSelect ? filterSelect.value : '');

    // Rebuild the per-day state FRESH (never reuse a stale enrichment) and
    // repaint the live calendar, so new confirmations/blocks repaint
    // immediately — including across month boundaries (bug fix).
    try {
      const avail = await getDocs(collection(db, 'availability'));
      adminAvailabilityDocs = Array.isArray(avail) ? avail : avail.docs;
    } catch (err) {
      console.error('Failed to refresh availability index:', err);
    }
    adminDayState = buildAdminDayState(allReservations, adminAvailabilityDocs);
    refreshAdminCalendar();
  }, (err) => {
    console.error('Reservations listener error:', err);
    showAdminMessage('Errore caricamento prenotazioni.', 'error');
  });

  if (filterSelect) {
    filterSelect.addEventListener('change', () => renderReservations(allReservations, filterSelect.value));
  }
}

function stopReservationsListener() {
  if (unsubscribeReservations) { unsubscribeReservations(); unsubscribeReservations = null; }
}

/* ─── calendar panel (v2: day-click popup) ────────────────────────────── */

function refreshAdminCalendar() {
  if (adminCalendarInstance) {
    decorateDays(adminCalendarInstance, adminDayState, { showTooltips: true });
  }
}

async function initAdminCalendarSection() {
  const calendarEl = document.getElementById('admin-calendar');
  if (!calendarEl) return;

  try {
    const avail = await getDocs(collection(db, 'availability'));
    adminAvailabilityDocs = Array.isArray(avail) ? avail : avail.docs;
  } catch (err) {
    console.error('Failed to load availability index:', err);
  }
  adminDayState = buildAdminDayState(allReservations, adminAvailabilityDocs);

  adminCalendarInstance = initAdminCalendar(calendarEl, adminDayState, null, {
    onMonthChange: () => refreshAdminCalendar(),
    onYearChange: () => refreshAdminCalendar()
  });
  // flatpickr (v4.6, the loaded bundle) exposes NO onDayClick option — only
  // onDayCreate. Intercept day clicks with a native capture listener on the
  // calendar container: preventDefault + stopPropagation blocks flatpickr's
  // own selection logic and opens the day popup instead.
  adminCalendarInstance.calendarContainer.addEventListener('click', onDayClickCapture, true);
  refreshAdminCalendar();
}

/* ─── day popup (poppover) ────────────────────────────────────────────── */

function onDayClickCapture(e) {
  const target = e.target;
  if (!target || !target.classList || !target.classList.contains('flatpickr-day')) return;
  if (target.classList.contains('flatpickr-disabled')) return;
  const ariaLabel = target.getAttribute('aria-label');
  if (!ariaLabel) return;
  const parsed = new Date(ariaLabel);
  if (isNaN(parsed.getTime())) return;
  e.preventDefault();
  e.stopPropagation();
  openDayPopup(formatDateISO(parsed));
}

function dateStrTitle(dateStr) {
  const s = new Date(dateStr + 'T12:00:00').toLocaleDateString('it-IT', {
    weekday: 'short', day: 'numeric', month: 'short', year: 'numeric'
  });
  return s.replace(/\b\w/g, c => c.toUpperCase()); // 'Gio 27 Ago 2026'
}

function getPendingOverlaps(dateStr) {
  return allReservations
    .filter(ds => ds.data().status === 'pending')
    .filter(ds => getDatesInRange(ds.data().checkIn, ds.data().checkOut).includes(dateStr))
    .map(ds => ({ id: ds.id, data: ds.data() }));
}

function openDayPopup(dateStr) {
  const popup = document.getElementById('day-popup');
  if (!popup) return;

  const st = adminDayState.get(dateStr);
  const occupied = st && (st.status === 'confirmed' || st.status === 'blocked');
  const isBlock = st && st.source === 'admin' && st.status === 'blocked';
  const pending = getPendingOverlaps(dateStr);

  popup.querySelector('.poppover__title').textContent = dateStrTitle(dateStr);

  const bodyEl = popup.querySelector('.poppover__body');
  let html = '';
  if (occupied) {
    html += `<div class="poppover__row ${isBlock ? 'poppover__row--blocked' : 'poppover__row--confirmed'}">
      <strong>${escapeHtml(st.name || (isBlock ? 'Blocco manuale' : 'Prenotazione'))}</strong>
      <span>${formatDateDisplay(st.checkIn)} → ${formatDateDisplay(st.checkOut)}</span>
      ${st.source === 'guest' ? `<small>Ospiti: ${st.guests || '?'}</small>` : ''}
    </div>`;
    if (!isBlock) {
      // Confirmed guest reservation → editable draft (applied only on Save).
      html += '<div class="pdraft"></div>';
      popup._draft = {
        checkIn: st.checkIn,
        checkOut: st.checkOut,
        guests: st.guests || 1,
        oldCheckIn: st.checkIn,
        oldCheckOut: st.checkOut,
        oldGuests: st.guests || 1
      };
      popup._bookedOther = null;
    } else {
      popup._draft = null;
    }
  } else {
    popup._draft = null;
    html += '<p class="poppover__free">Data libera</p>';
  }
  if (pending.length) {
    html += `<h4 class="poppover__pending-title">Richieste in attesa su questo giorno</h4>` + pending.map(p => `
      <div class="poppover__row poppover__row--pending">
        <strong>${escapeHtml(p.data.name || '-')}</strong>
        <span>${formatDateDisplay(p.data.checkIn)} → ${formatDateDisplay(p.data.checkOut)} · ${p.data.guests || '?'} ospiti</span>
        <span class="poppover__stepper">
          <button class="poppover__btn" data-confirm="${p.id}">Conferma</button>
          <button class="poppover__btn" data-reject="${p.id}">Rifiuta</button>
        </span>
      </div>`).join('');
  }
  bodyEl.innerHTML = html;

  const actionsEl = popup.querySelector('.poppover__actions');
  let actions = [];
  if (!occupied) {
    actions.push('<button class="poppover__btn btn-primary" data-action="occupy">Occupare manualmente</button>');
  } else if (isBlock) {
    actions.push('<button class="poppover__btn poppover__btn--danger" data-action="remove-block">Rimuovi blocco</button>');
  } else {
    actions.push(
      '<button class="poppover__btn btn-primary" data-action="draft-save" disabled>Salva modifiche</button>',
      '<button class="poppover__btn poppover__btn--danger" data-action="delete">Elimina prenotazione</button>'
    );
  }
  actionsEl.innerHTML = actions.join('');

  popup._dayDateStr = dateStr;
  popup.hidden = false;

  // Draft editor: render immediately, then fill real availability once the
  // fresh booked-dates read completes (validations depend on it).
  if (popup._draft) {
    renderDraftEditor(popup);
    const openedDay = dateStr;
    loadBookedDates(db)
      .then(booked => {
        if (popup.hidden || popup._dayDateStr !== openedDay) return; // reopened/closed meanwhile
        popup._bookedOther = booked;
        renderDraftEditor(popup);
      })
      .catch(err => console.error('Failed to load booked dates for popup:', err));
  }
}

function closeDayPopup() {
  const popup = document.getElementById('day-popup');
  if (popup) popup.hidden = true;
}

function initDayPopup() {
  const popup = document.getElementById('day-popup');
  if (!popup) return;

  popup.querySelector('.poppover__close').addEventListener('click', closeDayPopup);
  popup.querySelector('.poppover__backdrop').addEventListener('click', closeDayPopup);

  popup.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-action],[data-confirm],[data-reject]');
    if (!btn) return;
    const dateStr = popup._dayDateStr;
    const st = adminDayState.get(dateStr);

    if (btn.dataset.confirm) { confirmReservation(btn.dataset.confirm); closeDayPopup(); return; }
    if (btn.dataset.reject) { rejectReservation(btn.dataset.reject); closeDayPopup(); return; }

    // Draft editor actions only mutate local state — nothing is written until
    // [Salva modifiche] commits the whole draft in one batch.
    if (popup._draft && ['draft-in-minus', 'draft-in-plus', 'draft-out-minus', 'draft-out-plus'].includes(btn.dataset.action)) {
      stepDraft(popup, btn.dataset.action);
      return;
    }
    if (popup._draft && btn.dataset.action === 'draft-save') {
      saveDraftChanges(popup, st ? st.reservationId : null);
      return;
    }

    switch (btn.dataset.action) {
      case 'occupy': occupyDay(dateStr); break;
      case 'remove-block': removeBlockDay(st ? st.reservationId : null, dateStr); break;
      case 'delete': closeDayPopup(); deleteReservation(st ? st.reservationId : null); break;
    }
  });

  // Ospiti dropdown → local draft only.
  popup.addEventListener('change', (e) => {
    if (!popup._draft || !e.target.matches('.pdraft__select')) return;
    popup._draft.guests = parseInt(e.target.value, 10);
    renderDraftEditor(popup);
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !popup.hidden) closeDayPopup();
  });
}

/* ─── popup actions (all keep `availability` in sync) ─────────────────── */

async function occupyDay(dateStr) {
  try {
    const batch = writeBatch(db);
    const ref = doc(collection(db, 'reservations'));
    batch.set(ref, {
      source: 'admin',
      status: 'blocked',
      name: 'Blocco manuale',
      guests: 0,
      checkIn: dateStr,
      checkOut: dateStr,
      createdAt: serverTimestamp()
    });
    batch.set(doc(db, 'availability', dateStr), { reservationId: ref.id });
    await batch.commit();
    showAdminMessage(`${dateStr} bloccato manualmente (non disponibile per gli ospiti).`, 'success');
    closeDayPopup();
  } catch (err) {
    console.error('Occupy error:', err);
    showAdminMessage('Impossibile bloccare il giorno: data già occupata.', 'error');
  }
}

async function removeBlockDay(resId, dateStr) {
  if (!resId) return;
  try {
    const resRef = doc(db, 'reservations', resId);
    const snap = await getDoc(resRef);
    if (!snap.exists()) { showAdminMessage('Blocco non trovato.', 'error'); return; }

    const data = snap.data();
    const days = getDatesInRange(data.checkIn, data.checkOut);
    if (days.length === 1) {
      // Single-day block: remove the whole reservation + availability doc.
      closeDayPopup();
      return deleteReservation(resId);
    }

    // Multi-day block: remove just this day; if it splits the range into two,
    // create a second admin block reservation for the remainder.
    const ranges = groupContiguousDates(days.filter(d => d !== dateStr));
    const batch = writeBatch(db);
    batch.delete(doc(db, 'availability', dateStr));
    batch.update(resRef, { checkIn: ranges[0].checkIn, checkOut: ranges[0].checkOut });
    if (ranges.length === 2) {
      const ref = doc(collection(db, 'reservations'));
      batch.set(ref, {
        source: 'admin',
        status: 'blocked',
        name: 'Blocco manuale',
        guests: 0,
        checkIn: ranges[1].checkIn,
        checkOut: ranges[1].checkOut,
        createdAt: serverTimestamp()
      });
      getDatesInRange(ranges[1].checkIn, ranges[1].checkOut).forEach(d => {
        batch.set(doc(db, 'availability', d), { reservationId: ref.id });
      });
    }
    await batch.commit();
    showAdminMessage('Blocco aggiornato.', 'success');
    closeDayPopup();
  } catch (err) {
    console.error('Remove block error:', err);
    showAdminMessage('Errore durante la rimozione del blocco.', 'error');
  }
}

/* ─── draft editor (confirmed reservations) ───────────────────────────── */
// The popup holds a local draft {checkIn, checkOut, guests} plus the ORIGINAL
// range (oldCheckIn/oldCheckOut) so availability sync can compute exactly
// which days are freed vs newly claimed. Nothing touches Firestore until
// [Salva modifiche] commits the whole draft in ONE writeBatch.

function compactDateLabel(dateStr) {
  if (!dateStr) return '-';
  const s = new Date(dateStr + 'T12:00:00').toLocaleDateString('it-IT', {
    weekday: 'short', day: 'numeric', month: 'short'
  });
  return s.replace(/\b\w/g, c => c.toUpperCase()); // 'Sab 22 Ago'
}

/**
 * Pure draft validation — mirrored in /tmp/villast-draft-validate.test.mjs.
 * bookedSet: fresh Set of occupied YYYY-MM-DD from Availability (or null while
 * the async read is still in flight). This reservation's own old days are
 * excluded before the overlap test, since they are the days the edit frees.
 */
function validateDraft(d, bookedSet) {
  const out = { ok: false, msg: '', nights: 0, delDays: [], setDays: [] };
  if (!d.checkIn || !d.checkOut) { out.msg = 'Indica le date di arrivo e partenza.'; return out; }

  const oldDays = getDatesInRange(d.oldCheckIn, d.oldCheckOut);
  const newDays = getDatesInRange(d.checkIn, d.checkOut);
  out.nights = newDays.length;
  out.delDays = oldDays.filter(day => !newDays.includes(day)); // freed days
  out.setDays = newDays.filter(day => !oldDays.includes(day)); // newly claimed days

  if (out.nights < 1) { out.msg = 'Durata minima: 1 notte (la partenza deve seguire l\'arrivo).'; return out; }
  if (!d.guests || d.guests < 1) { out.msg = 'Indica almeno 1 ospite.'; return out; }
  if (!bookedSet) { out.msg = 'Verifica disponibilità…'; return out; }

  const others = new Set([...bookedSet].filter(day => !oldDays.includes(day)));
  const clash = newDays.find(day => others.has(day));
  if (clash) { out.msg = `Il giorno ${formatDateDisplay(clash)} è già occupato: modifica le date.`; return out; }

  out.ok = true;
  out.msg = `Notte/i: ${out.nights}`;
  return out;
}

function stepDraft(popup, action) {
  const field = action.startsWith('draft-in') ? 'checkIn' : 'checkOut';
  const delta = action.endsWith('plus') ? 1 : -1;
  popup._draft[field] = addDays(popup._draft[field], delta);
  renderDraftEditor(popup);
}

function renderDraftEditor(popup) {
  const root = popup.querySelector('.pdraft');
  const saveBtn = popup.querySelector('[data-action="draft-save"]');
  if (!root || !popup._draft) return;

  const d = popup._draft;
  const v = validateDraft(d, popup._bookedOther);

  // Small pretty steppers: compact round ± buttons, disabled at hard limits
  // (check-in can't move past check-out, check-out can't move before it).
  const inMinusDisabled = addDays(d.checkIn, -1) > d.checkOut;
  const inPlusDisabled = addDays(d.checkIn, 1) > d.checkOut;
  const outMinusDisabled = addDays(d.checkOut, -1) < d.checkIn;
  const outPlusDisabled = addDays(d.checkOut, 1) < d.checkIn;

  const guestOptions = [];
  const guestsMax = Math.max(MAX_GUESTS, d.guests);
  for (let g = 1; g <= guestsMax; g++) {
    guestOptions.push(`<option value="${g}"${g === d.guests ? ' selected' : ''}>${g} ${g === 1 ? 'ospite' : 'ospiti'}</option>`);
  }

  const stepBtn = (action, label, glyph, disabled) =>
    `<button class="pdraft__step" data-action="${action}" aria-label="${label}" ${disabled ? 'disabled' : ''}>${glyph}</button>`;

  root.innerHTML = `
    <div class="pdraft__field">
      <label class="pdraft__label" for="pdraft-guests">Ospiti</label>
      <select id="pdraft-guests" class="pdraft__select">${guestOptions.join('')}</select>
    </div>
    <div class="pdraft__field">
      <span class="pdraft__label">Giorno arrivo</span>
      <div class="pdraft__steprow">
        ${stepBtn('draft-in-minus', 'Arrivo: un giorno prima', '&minus;', inMinusDisabled)}
        <span class="pdraft__date">${compactDateLabel(d.checkIn)}</span>
        ${stepBtn('draft-in-plus', 'Arrivo: un giorno dopo', '&plus;', inPlusDisabled)}
      </div>
    </div>
    <div class="pdraft__field">
      <span class="pdraft__label">Giorno partenza</span>
      <div class="pdraft__steprow">
        ${stepBtn('draft-out-minus', 'Partenza: un giorno prima', '&minus;', outMinusDisabled)}
        <span class="pdraft__date">${compactDateLabel(d.checkOut)}</span>
        ${stepBtn('draft-out-plus', 'Partenza: un giorno dopo', '&plus;', outPlusDisabled)}
      </div>
    </div>
    <p class="pdraft__check ${v.ok ? 'pdraft__check--ok' : (v.msg.startsWith('Verifica') ? 'pdraft__check--warn' : 'pdraft__check--err')}">${escapeHtml(v.msg)}</p>`;

  const differs = d.checkIn !== d.oldCheckIn || d.checkOut !== d.oldCheckOut || d.guests !== d.oldGuests;
  if (saveBtn) saveBtn.disabled = !(v.ok && differs);
}

async function saveDraftChanges(popup, resId) {
  if (!resId || !popup._draft) return;
  const d = popup._draft;
  try {
    // Fresh overlap read at commit time (the popup snapshot may be stale if a
    // confirm happened elsewhere meanwhile; availability set/delete is also
    // create/delete-only in the Firestore rules as a second line of defense).
    const booked = await loadBookedDates(db);
    const v = validateDraft(d, booked);
    if (!v.ok) {
      showAdminMessage(v.msg, 'error');
      popup._bookedOther = booked;
      renderDraftEditor(popup);
      return;
    }

    // ONE batch: reservation update + availability sync (free old days, claim new).
    const batch = writeBatch(db);
    batch.update(doc(db, 'reservations', resId), {
      checkIn: d.checkIn,
      checkOut: d.checkOut,
      guests: d.guests
    });
    v.delDays.forEach(day => batch.delete(doc(db, 'availability', day)));
    v.setDays.forEach(day => batch.set(doc(db, 'availability', day), { reservationId: resId }));
    await batch.commit();
    showAdminMessage('Modifiche salvate. Date e ospiti aggiornati.', 'success');
    closeDayPopup();
  } catch (err) {
    console.error('Save draft error:', err);
    showAdminMessage('Impossibile salvare: alcune date risultano già occupate.', 'error');
  }
}

/* ─── panels / auth ───────────────────────────────────────────────────── */

function initPanelSwitching() {
  const sidebarLinks = document.querySelectorAll('.sidebar-link[data-panel]');
  const panels = {
    reservations: document.getElementById('reservations-panel'),
    calendar: document.getElementById('calendar-panel')
  };

  sidebarLinks.forEach(link => {
    link.addEventListener('click', (e) => {
      e.preventDefault();
      const panelName = link.dataset.panel;
      sidebarLinks.forEach(l => l.classList.remove('active'));
      link.classList.add('active');
      Object.entries(panels).forEach(([name, el]) => {
        if (!el) return;
        el.style.display = name === panelName ? '' : 'none';
      });
      if (panelName === 'calendar') {
        if (adminCalendarInstance) {
          adminCalendarInstance.destroy();
          adminCalendarInstance = null;
        }
        initAdminCalendarSection();
      }
    });
  });
}

function showDashboard() {
  hideEl(document.getElementById('login-screen'));
  showEl(document.getElementById('dashboard'));
  startReservationsListener();
  initPanelSwitching();
  // Calendar is the primary/default panel (admin.html marks it active):
  // initialize it right away, not only after a sidebar click.
  const activeLink = document.querySelector('.sidebar-link[data-panel].active');
  if (activeLink && activeLink.dataset.panel === 'calendar' && !adminCalendarInstance) {
    initAdminCalendarSection();
  }
}

function showLogin() {
  showEl(document.getElementById('login-screen'));
  hideEl(document.getElementById('dashboard'));
  stopReservationsListener();
  if (adminCalendarInstance) { adminCalendarInstance.destroy(); adminCalendarInstance = null; }
}

document.addEventListener('DOMContentLoaded', () => {
  onAuthStateChanged(auth, (user) => {
    if (user) showDashboard(); else showLogin();
  });

  initDayPopup();

  const loginForm = document.getElementById('login-form');
  if (loginForm) {
    loginForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      hideLoginError();
      const email = document.getElementById('login-email').value.trim();
      const password = document.getElementById('login-password').value;
      const submitBtn = loginForm.querySelector('[type="submit"]');
      if (!email || !password) { showLoginError('Inserisci email e password.'); return; }
      if (submitBtn) { submitBtn.disabled = true; submitBtn.textContent = 'Accesso...'; }
      try {
        await signInWithEmailAndPassword(auth, email, password);
      } catch (err) {
        console.error('Login error:', err);
        showLoginError('Email o password non corretti.');
        if (submitBtn) { submitBtn.disabled = false; submitBtn.textContent = 'Accedi'; }
      }
    });
  }

  const signOutBtn = document.getElementById('sign-out-btn');
  if (signOutBtn) {
    signOutBtn.addEventListener('click', async () => {
      try { await signOut(auth); } catch (err) { console.error('Sign out error:', err); }
    });
  }
});
