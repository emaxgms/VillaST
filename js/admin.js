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
        <td>${guestCell}</td>
        <td>${contactCell}</td>
        <td>${formatDateDisplay(d.checkIn)} - ${formatDateDisplay(d.checkOut)}</td>
        <td>${d.guests || '-'}</td>
        <td><span class="${badgeClass}">${statusLabel(d.status)}</span></td>
        <td class="action-cell">${actions.join('')}</td>
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
  } else {
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
      '<button class="poppover__btn" data-action="duration-minus">Durata −1</button>',
      '<button class="poppover__btn" data-action="duration-plus">Durata +1</button>',
      '<button class="poppover__btn" data-action="guests-minus">Ospiti −1</button>',
      '<button class="poppover__btn" data-action="guests-plus">Ospiti +1</button>',
      '<button class="poppover__btn poppover__btn--danger" data-action="delete">Elimina prenotazione</button>'
    );
  }
  actionsEl.innerHTML = actions.join('');

  popup._dayDateStr = dateStr;
  popup.hidden = false;
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

    switch (btn.dataset.action) {
      case 'occupy': occupyDay(dateStr); break;
      case 'remove-block': removeBlockDay(st ? st.reservationId : null, dateStr); break;
      case 'duration-plus': changeDuration(st ? st.reservationId : null, +1); break;
      case 'duration-minus': changeDuration(st ? st.reservationId : null, -1); break;
      case 'guests-plus': changeGuests(st ? st.reservationId : null, +1); break;
      case 'guests-minus': changeGuests(st ? st.reservationId : null, -1); break;
      case 'delete': closeDayPopup(); deleteReservation(st ? st.reservationId : null); break;
    }
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

async function changeDuration(resId, deltaDays) {
  if (!resId) return;
  try {
    const resRef = doc(db, 'reservations', resId);
    const snap = await getDoc(resRef);
    if (!snap.exists()) { showAdminMessage('Prenotazione non trovata.', 'error'); return; }

    const data = snap.data();
    if (deltaDays > 0) {
      // Extend checkOut by one day, with overlap prevention (fresh read).
      const newOut = addDays(data.checkOut, 1);
      const booked = await loadBookedDates(db);
      if (booked.has(newOut)) {
        showAdminMessage(`${newOut} è già occupata: impossibile estendere.`, 'error');
        return;
      }
      const batch = writeBatch(db);
      batch.update(resRef, { checkOut: newOut });
      batch.set(doc(db, 'availability', newOut), { reservationId: resId });
      await batch.commit();
      showAdminMessage('Durata estesa di 1 giorno.', 'success');
      closeDayPopup();
    } else {
      // Shrink checkOut by one day (minimum 1-night stay).
      const newOut = addDays(data.checkOut, -1);
      if (newOut < data.checkIn) {
        showAdminMessage('La durata minima è 1 giorno.', 'error');
        return;
      }
      const batch = writeBatch(db);
      batch.update(resRef, { checkOut: newOut });
      batch.delete(doc(db, 'availability', data.checkOut));
      await batch.commit();
      showAdminMessage('Durata ridotta di 1 giorno.', 'success');
      closeDayPopup();
    }
  } catch (err) {
    console.error('Duration error:', err);
    showAdminMessage('Errore aggiornamento durata.', 'error');
  }
}

async function changeGuests(resId, delta) {
  if (!resId) return;
  try {
    const resRef = doc(db, 'reservations', resId);
    const snap = await getDoc(resRef);
    if (!snap.exists()) { showAdminMessage('Prenotazione non trovata.', 'error'); return; }

    const guests = Math.max(1, (snap.data().guests || 1) + delta);
    await writeBatch(db).update(resRef, { guests }).commit();
    showAdminMessage(`Ospiti aggiornati: ${guests}.`, 'success');
    closeDayPopup();
  } catch (err) {
    console.error('Guests error:', err);
    showAdminMessage('Errore aggiornamento ospiti.', 'error');
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
