/**
 * admin.js — Admin dashboard logic (v4: mobile-first, requests queue home)
 * VillaST — San Teodoro, Sardegna
 *
 * Single source of truth: the `reservations` collection.
 *  - guest requests    : { source: 'guest', status: 'pending' }
 *  - confirmed bookings: { status: 'confirmed' }
 *  - manual blocks     : { source: 'admin', status: 'blocked' }
 *
 * Occupied statuses (dates taken): 'confirmed' and 'blocked'.
 * The `availability` collection is a derived per-day occupancy index kept in
 * sync by every mutation below, and claim-protected by Firestore rules so two
 * concurrent confirms cannot reserve the same day.
 *
 * Panels: Richieste (home) · Calendario · Prenotazioni · Impostazioni.
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
  registerServiceWorker,
  getNotificationState,
  enableNotifications,
  sendTestPush,
  initForegroundHandler
} from './notify-client.js';
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
let foregroundWired = false;

// Max guests selectable in the popup draft editor.
const MAX_GUESTS = 4;

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
  clearTimeout(showAdminMessage._t);
  showAdminMessage._t = setTimeout(() => { el.style.display = 'none'; }, 4500);
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

function dateStrTitle(dateStr) {
  const s = new Date(dateStr + 'T12:00:00').toLocaleDateString('it-IT', {
    weekday: 'short', day: 'numeric', month: 'short', year: 'numeric'
  });
  return s.replace(/\b\w/g, c => c.toUpperCase()); // 'Gio 27 Ago 2026'
}

function compactDateLabel(dateStr) {
  if (!dateStr) return '-';
  const s = new Date(dateStr + 'T12:00:00').toLocaleDateString('it-IT', {
    weekday: 'short', day: 'numeric', month: 'short'
  });
  return s.replace(/\b\w/g, c => c.toUpperCase()); // 'Sab 22 Ago'
}

function shortDate(isoStr) {
  if (!isoStr) return '-';
  const s = new Date(isoStr + 'T12:00:00').toLocaleDateString('it-IT', { day: 'numeric', month: 'short' });
  return s.replace('.', '');
}

function nightsOf(checkIn, checkOut) {
  // Inclusive day count: the occupancy model blocks the check-out day too.
  return getDatesInRange(checkIn, checkOut).length;
}

function nightsBetween(checkIn, checkOut) {
  // Guest-facing "notti": 12 -> 18 is 6 nights (7 occupied days).
  return Math.max(1, nightsOf(checkIn, checkOut) - 1);
}

function timestampMs(docSnap) {
  const ts = docSnap.data().createdAt;
  if (ts && typeof ts.toDate === 'function') return ts.toDate().getTime();
  if (ts && ts.seconds) return ts.seconds * 1000;
  return 0;
}

function relativeAge(ms) {
  if (!ms) return '';
  const diff = Date.now() - ms;
  const min = Math.floor(diff / 60000);
  if (min < 2) return 'adesso';
  if (min < 60) return `${min} min fa`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h}h fa`;
  const d = Math.floor(h / 24);
  return `${d}g fa`;
}

function whenLabel(isoDay) {
  const today = formatDateISO(new Date());
  const tomorrow = addDays(today, 1);
  if (isoDay === today) return 'oggi';
  if (isoDay === tomorrow) return 'domani';
  const diff = Math.round((new Date(isoDay + 'T12:00:00') - new Date(today + 'T12:00:00')) / 86400000);
  return diff > 1 ? `tra ${diff} giorni` : 'passato';
}

/** Occupied days (confirmed or blocked) inside a request's range. */
function occupiedDaysInRange(checkIn, checkOut) {
  return getDatesInRange(checkIn, checkOut).filter((day) => {
    const st = adminDayState.get(day);
    return st && (st.status === 'confirmed' || st.status === 'blocked');
  });
}

function conflictNote(days) {
  const st = adminDayState.get(days[0]);
  if (!st) return '';
  const who = st.source === 'admin' && st.status === 'blocked'
    ? 'a un blocco manuale'
    : `alla prenotazione confermata di ${escapeHtml(st.name || 'un ospite')}`;
  const range = st.checkIn && st.checkOut ? ` (${shortDate(st.checkIn)} → ${shortDate(st.checkOut)})` : '';
  return `Si sovrappone ${who}${range}`;
}

/* ─── rendering ───────────────────────────────────────────────────────── */

function renderStats() {
  const all = allReservations.map(ds => ds.data());
  const pending = all.filter(d => d.status === 'pending').length;
  const confirmed = all.filter(d => d.status === 'confirmed').length;
  const blocked = all.filter(d => d.status === 'blocked').length;

  const setText = (id, text) => { const el = document.getElementById(id); if (el) el.textContent = text; };
  setText('chip-pending', `${pending} in attesa`);
  setText('chip-pending-2', `${pending} in attesa`);
  setText('chip-confirmed', `${confirmed} confermate`);
  setText('chip-blocked', `${blocked} bloccate`);

  const badge = document.getElementById('tab-pending-count');
  if (badge) {
    badge.textContent = String(pending);
    badge.hidden = pending === 0;
  }
}

function renderRequests() {
  const list = document.getElementById('requests-list');
  if (!list) return;

  const pendingDocs = allReservations
    .filter(ds => ds.data().status === 'pending')
    .sort((a, b) => timestampMs(b) - timestampMs(a));

  let conflicts = 0;
  const cards = pendingDocs.map(ds => {
    const d = ds.data();
    const days = occupiedDaysInRange(d.checkIn, d.checkOut);
    const hasConflict = days.length > 0;
    if (hasConflict) conflicts++;

    return `
      <article class="req-card${hasConflict ? ' req-card--conflict' : ''}">
        <div class="req-card__top">
          <div>
            <h3 class="req-card__name">${escapeHtml(d.name || 'Senza nome')}</h3>
            <p class="req-card__meta">${shortDate(d.checkIn)} → ${shortDate(d.checkOut)} · ${nightsBetween(d.checkIn, d.checkOut)} notti · ${d.guests || '?'} ospiti</p>
          </div>
          <span class="req-card__age">${relativeAge(timestampMs(ds))}</span>
        </div>
        ${hasConflict ? `<p class="req-card__warn">⚠ ${conflictNote(days)}</p>` : ''}
        <div class="req-card__actions">
          <button class="btn-accept" data-confirm="${ds.id}" ${hasConflict ? 'disabled title="Date occupate: rifiuta o libera prima le date"' : ''}>Accetta</button>
          <button class="btn-reject" data-reject="${ds.id}">Rifiuta</button>
        </div>
      </article>`;
  }).join('');

  list.innerHTML = cards || '<p class="empty-note">Nessuna richiesta in attesa.</p>';

  const chip = document.getElementById('chip-conflict');
  if (chip) {
    chip.textContent = `${conflicts} con conflitto`;
    chip.hidden = conflicts === 0;
  }
}

function renderUpcoming() {
  const list = document.getElementById('upcoming-list');
  if (!list) return;

  const today = formatDateISO(new Date());
  const arrivals = allReservations
    .filter(ds => {
      const d = ds.data();
      return d.status === 'confirmed' && d.source !== 'admin' && d.checkOut >= today;
    })
    .sort((a, b) => (a.data().checkIn || '').localeCompare(b.data().checkIn || ''))
    .slice(0, 3);

  list.innerHTML = arrivals.length
    ? arrivals.map(ds => {
        const d = ds.data();
        return `
          <div class="arrival-row">
            <div>
              <b>${escapeHtml(d.name || '-')}</b>
              <div class="muted">${d.guests || '?'} ospiti · ${nightsBetween(d.checkIn, d.checkOut)} notti</div>
            </div>
            <div class="arrival-when"><b>${whenLabel(d.checkIn)}</b><br>${shortDate(d.checkIn)} → ${shortDate(d.checkOut)}</div>
          </div>`;
      }).join('')
    : '<p class="empty-note">Nessun arrivo in programma.</p>';
}

function renderReservations(docs, filterStatus = '', search = '') {
  const tbody = document.getElementById('reservations-tbody');
  if (!tbody) return;

  const term = search.trim().toLowerCase();
  const filtered = docs.filter(ds => {
    const d = ds.data();
    if (filterStatus && d.status !== filterStatus) return false;
    if (!term) return true;
    return `${d.name || ''} ${d.email || ''}`.toLowerCase().includes(term);
  });

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

function renderAll() {
  renderStats();
  renderRequests();
  renderUpcoming();
  const filterSelect = document.getElementById('filter-status');
  const searchInput = document.getElementById('search-reservations');
  renderReservations(allReservations, filterSelect ? filterSelect.value : '', searchInput ? searchInput.value : '');
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
  const searchInput = document.getElementById('search-reservations');

  unsubscribeReservations = onSnapshot(q, async (snapshot) => {
    allReservations = snapshot.docs;

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

    renderAll();
    refreshAdminCalendar();
  }, (err) => {
    console.error('Reservations listener error:', err);
    showAdminMessage('Errore caricamento prenotazioni.', 'error');
  });

  if (filterSelect) {
    filterSelect.addEventListener('change', () => renderReservations(allReservations, filterSelect.value, searchInput ? searchInput.value : ''));
  }
  if (searchInput) {
    searchInput.addEventListener('input', () => renderReservations(allReservations, filterSelect ? filterSelect.value : '', searchInput.value));
  }

  // Requests queue: one delegated listener, wired once.
  const list = document.getElementById('requests-list');
  if (list) {
    list.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-confirm],[data-reject]');
      if (!btn) return;
      if (btn.dataset.confirm) confirmReservation(btn.dataset.confirm);
      if (btn.dataset.reject) rejectReservation(btn.dataset.reject);
    });
  }
}

function stopReservationsListener() {
  if (unsubscribeReservations) { unsubscribeReservations(); unsubscribeReservations = null; }
}

/* ─── calendar panel (day-click bottom sheet) ─────────────────────────── */

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
  // own selection logic and opens the day sheet instead.
  adminCalendarInstance.calendarContainer.addEventListener('click', onDayClickCapture, true);
  refreshAdminCalendar();
}

/* ─── day sheet ───────────────────────────────────────────────────────── */

function onDayClickCapture(e) {
  const target = e.target;
  if (!target || !target.classList || !target.classList.contains('flatpickr-day')) return;
  if (target.classList.contains('flatpickr-disabled')) return;
  // Locale-proof date extraction: the day number inside the cell + the month
  // and year the instance is showing (parsing the aria-label breaks as soon as
  // the calendar is not in English).
  if (!adminCalendarInstance) return;
  const dayNum = parseInt(target.textContent, 10);
  if (!dayNum) return;
  const date = new Date(adminCalendarInstance.currentYear, adminCalendarInstance.currentMonth, dayNum);
  if (isNaN(date.getTime())) return;
  e.preventDefault();
  e.stopPropagation();
  openDayPopup(formatDateISO(date));
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
      '<button class="poppover__btn poppover__btn--danger" data-action="delete">Elimina</button>'
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
// The sheet holds a local draft {checkIn, checkOut, guests} plus the ORIGINAL
// range (oldCheckIn/oldCheckOut) so availability sync can compute exactly
// which days are freed vs newly claimed. Nothing touches Firestore until
// [Salva modifiche] commits the whole draft in ONE writeBatch.

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
  out.msg = `Giorni occupati: ${out.nights}`;
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

  // Small steppers: compact round ± buttons, disabled at hard limits
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

/* ─── panels / settings / auth ────────────────────────────────────────── */

const PANELS = {
  requests: { title: 'Richieste' },
  calendar: { title: 'Calendario' },
  reservations: { title: 'Prenotazioni' },
  settings: { title: 'Impostazioni' }
};

function panelEl(name) { return document.getElementById(`${name}-panel`); }

function activatePanel(name) {
  if (!PANELS[name]) return;
  document.querySelectorAll('.sidebar-link[data-panel]').forEach(link => {
    link.classList.toggle('active', link.dataset.panel === name);
  });
  Object.keys(PANELS).forEach(key => {
    const el = panelEl(key);
    if (!el) return;
    if (key === name) showEl(el); else hideEl(el);
  });
  const title = document.getElementById('dash-title');
  if (title) title.textContent = PANELS[name].title;

  if (name === 'calendar') {
    if (adminCalendarInstance) {
      adminCalendarInstance.destroy();
      adminCalendarInstance = null;
    }
    initAdminCalendarSection();
  }
}

function initPanelSwitching() {
  document.querySelectorAll('.sidebar-link[data-panel]').forEach(link => {
    link.addEventListener('click', (e) => {
      e.preventDefault();
      activatePanel(link.dataset.panel);
    });
  });
}

async function refreshNotifyState() {
  const text = document.getElementById('notify-state-text');
  const dot = document.getElementById('notify-dot');
  const enableBtn = document.getElementById('enable-notifications-btn');
  if (!text || !dot) return;

  const state = await getNotificationState();
  text.textContent = state.text;
  dot.className = `state-dot state-dot--${state.level === 'on' ? 'on' : (state.level === 'warn' ? 'warn' : 'off')}`;
  if (enableBtn) {
    enableBtn.hidden = !state.canEnable;
    enableBtn.disabled = false;
    enableBtn.textContent = 'Attiva notifiche';
  }
}

function wireSettings(currentUser) {
  const emailEl = document.getElementById('admin-email');
  const uidEl = document.getElementById('admin-uid');
  const emailBadge = document.getElementById('admin-email-badge');
  if (emailEl) emailEl.textContent = currentUser.email || '—';
  if (uidEl) uidEl.textContent = currentUser.uid || '—';
  if (emailBadge) emailBadge.textContent = currentUser.email || 'Admin';

  const enableBtn = document.getElementById('enable-notifications-btn');
  if (enableBtn && !enableBtn._wired) {
    enableBtn._wired = true;
    enableBtn.addEventListener('click', async () => {
      enableBtn.disabled = true;
      enableBtn.textContent = 'Attivazione…';
      try {
        await enableNotifications();
        showAdminMessage('Notifiche attive su questo dispositivo.', 'success');
      } catch (err) {
        console.error('Enable notifications failed:', err);
        showAdminMessage(err && err.message ? err.message : 'Attivazione non riuscita.', 'error');
      }
      refreshNotifyState();
    });
  }

  const testBtn = document.getElementById('test-push-btn');
  if (testBtn && !testBtn._wired) {
    testBtn._wired = true;
    testBtn.addEventListener('click', async () => {
      testBtn.disabled = true;
      try {
        await sendTestPush();
        showAdminMessage('Push di prova richiesta: arriva entro pochi minuti.', 'success');
      } catch (err) {
        console.error('Test push failed:', err);
        showAdminMessage('Invio della push di prova non riuscito.', 'error');
      }
      setTimeout(() => { testBtn.disabled = false; }, 3000);
    });
  }

  refreshNotifyState();
}

function showDashboard(user) {
  hideEl(document.getElementById('login-screen'));
  showEl(document.getElementById('dashboard'));
  startReservationsListener();
  initPanelSwitching();
  wireSettings(user);
  // Home = the requests queue; the calendar initialises lazily on first visit.
  activatePanel('requests');

  registerServiceWorker().then(() => {
    if (foregroundWired) return;
    foregroundWired = true;
    initForegroundHandler((note) => {
      showAdminMessage(`${note.title || 'Nuova richiesta'}${note.body ? ' — ' + note.body : ''}`, 'success');
    });
    refreshNotifyState();
  });
}

function showLogin() {
  showEl(document.getElementById('login-screen'));
  hideEl(document.getElementById('dashboard'));
  stopReservationsListener();
  if (adminCalendarInstance) { adminCalendarInstance.destroy(); adminCalendarInstance = null; }
}

document.addEventListener('DOMContentLoaded', () => {
  onAuthStateChanged(auth, (user) => {
    if (user) showDashboard(user); else showLogin();
  });

  initDayPopup();

  // Arm the push receiver as soon as the panel opens: the SW must exist for
  // foreground messages, and having the registration in memory is what makes
  // the Impostazioni state report Attive on the next load.
  registerServiceWorker().then(() => {
    initForegroundHandler((note) => {
      showAdminMessage(`${note.title || 'Nuova notifica'}${note.body ? ': ' + note.body : ''}`, 'success');
    });
  });

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

  ['sign-out-btn', 'sign-out-btn-2'].forEach(id => {
    const btn = document.getElementById(id);
    if (!btn) return;
    btn.addEventListener('click', async () => {
      try { await signOut(auth); } catch (err) { console.error('Sign out error:', err); }
    });
  });
});
