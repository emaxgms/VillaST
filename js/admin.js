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
import { loadBookedDates, loadBookedDatesWithMeta, initAdminCalendar, decorateDays, formatDateISO, getDatesInRange, groupContiguousDates } from './calendar.js';
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
let bookedDatesMeta = new Map();
let allReservations = [];
let currentAdminSelectedDates = [];
let saveManualBlocksListenerAttached = false;

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

/* ─── availability reconciliation (manual blocks) ─────────────────────── */

async function saveManualBlocks(selectedDates) {
  const selectedSet = new Set(selectedDates.map(formatDateISO));

  // Fresh read — never rely on possibly-stale UI state for a write.
  const reservations = (await getDocs(collection(db, 'reservations'))).docs;

  // Confirmed reservations are immutable from this view.
  const confirmedDates = new Set();
  reservations.forEach(ds => {
    const d = ds.data();
    if (d.status === 'confirmed') {
      getDatesInRange(d.checkIn, d.checkOut).forEach(x => confirmedDates.add(x));
    }
  });

  const targetManual = new Set([...selectedSet].filter(d => !confirmedDates.has(d)));

  const manualSnaps = reservations.filter(ds => ds.data().source === 'admin' && ds.data().status === 'blocked');
  const manualIds = new Set(manualSnaps.map(ds => ds.id));

  const availMeta = await loadBookedDatesWithMeta(db);

  // Phase 1 — remove existing manual reservations and their availability docs
  // (plus any legacy orphan docs with no reservationId). Runs in its own batch
  // so the day docs we are about to re-claim are gone before we create them.
  const deleteBatch = writeBatch(db);
  manualSnaps.forEach(ds => deleteBatch.delete(doc(db, 'reservations', ds.id)));
  availMeta.forEach((meta, dateStr) => {
    if (meta.reservationId === null || manualIds.has(meta.reservationId)) {
      deleteBatch.delete(doc(db, 'availability', dateStr));
    }
  });
  await deleteBatch.commit();

  // Phase 2 — re-create manual blocks as reservation records + availability docs.
  const createBatch = writeBatch(db);
  groupContiguousDates(targetManual).forEach(({ checkIn, checkOut }) => {
    const ref = doc(collection(db, 'reservations'));
    createBatch.set(ref, {
      source: 'admin',
      status: 'blocked',
      name: 'Blocco manuale',
      guests: 0,
      checkIn,
      checkOut,
      createdAt: serverTimestamp()
    });
    getDatesInRange(checkIn, checkOut).forEach(d => {
      createBatch.set(doc(db, 'availability', d), { reservationId: ref.id });
    });
  });
  await createBatch.commit();

  showAdminMessage('Disponibilità aggiornata!', 'success');
}

/* ─── listeners ───────────────────────────────────────────────────────── */

function startReservationsListener() {
  const q = query(collection(db, 'reservations'), orderBy('createdAt', 'desc'));
  const filterSelect = document.getElementById('filter-status');

  unsubscribeReservations = onSnapshot(q, (snapshot) => {
    allReservations = snapshot.docs;
    renderReservations(allReservations, filterSelect ? filterSelect.value : '');
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

/* ─── calendar panel ──────────────────────────────────────────────────── */

function attachDayTooltips(calendarEl) {
  calendarEl.querySelectorAll('.flatpickr-day:not(.prevMonthDay):not(.nextMonthDay)').forEach(dayEl => {
    dayEl.addEventListener('mouseenter', onDayMouseenter);
    dayEl.addEventListener('mouseleave', onDayMouseleave);
  });
}

function onDayMouseleave(e) {
  const existing = e.currentTarget.querySelector('.day-tooltip');
  if (existing) existing.remove();
}

async function onDayMouseenter(e) {
  const dayEl = e.currentTarget;
  if (dayEl.classList.contains('flatpickr-disabled')) return;

  const ariaLabel = dayEl.getAttribute('aria-label');
  if (!ariaLabel) return;

  const parsed = new Date(ariaLabel);
  if (isNaN(parsed.getTime())) return;
  const dateStr = formatDateISO(parsed);

  const meta = bookedDatesMeta.get(dateStr);
  if (!meta) return;

  const tooltip = document.createElement('div');
  tooltip.className = 'day-tooltip';
  tooltip.textContent = '...';
  dayEl.style.position = 'relative';
  dayEl.appendChild(tooltip);

  if (meta.reservationId) {
    try {
      const resSnap = await getDoc(doc(db, 'reservations', meta.reservationId));
      if (!dayEl.querySelector('.day-tooltip')) return;
      if (resSnap.exists()) {
        const rd = resSnap.data();
        tooltip.textContent = (rd.source === 'admin' && rd.status === 'blocked')
          ? 'Bloccata manualmente'
          : (rd.name || 'Prenotazione');
      } else {
        tooltip.textContent = 'Prenotazione non trovata';
      }
    } catch {
      if (dayEl.querySelector('.day-tooltip')) tooltip.textContent = 'Errore';
    }
  } else {
    tooltip.textContent = 'Bloccata manualmente';
  }
}

async function initAdminCalendarSection() {
  const calendarEl = document.getElementById('admin-calendar');
  if (!calendarEl) return;
  currentAdminSelectedDates = [];

  try {
    bookedDatesMeta = await loadBookedDatesWithMeta(db);
  } catch (err) {
    console.error('Failed to load booked dates:', err);
    bookedDatesMeta = new Map();
  }

  // Enrich availability metadata with source/status from reservation docs
  // so the calendar can color manual admin blocks differently from guest bookings.
  const reservationById = new Map(allReservations.map(ds => [ds.id, ds.data()]));
  bookedDatesMeta.forEach((meta, dateStr) => {
    const res = meta.reservationId ? reservationById.get(meta.reservationId) : null;
    if (res) {
      meta.source = res.source || meta.source;
      meta.status = res.status || meta.status;
    }
  });

  const occupied = new Set(bookedDatesMeta.keys());

  adminCalendarInstance = initAdminCalendar(calendarEl, occupied, (selectedDates) => {
    currentAdminSelectedDates = selectedDates;
  }, {
    // Flatpickr builds days in a detached fragment: onDayCreate fires before
    // day elements exist in calendarContainer, so decorateDays there finds
    // nothing. Decorate explicitly after render and on every month change.
    onMonthChange: () => {
      decorateDays(adminCalendarInstance, bookedDatesMeta, { showTooltips: true });
      attachDayTooltips(calendarEl);
    },
    onYearChange: () => {
      decorateDays(adminCalendarInstance, bookedDatesMeta, { showTooltips: true });
      attachDayTooltips(calendarEl);
    },
    _bookedDatesMeta: bookedDatesMeta
  });
  decorateDays(adminCalendarInstance, bookedDatesMeta, { showTooltips: true });
  attachDayTooltips(calendarEl);
  currentAdminSelectedDates = Array.from(occupied).map(d => new Date(d + 'T00:00:00'));

  const saveBtn = document.getElementById('save-availability-btn');
  if (saveBtn && !saveManualBlocksListenerAttached) {
    saveManualBlocksListenerAttached = true;
    saveBtn.addEventListener('click', async () => {
      saveBtn.disabled = true;
      saveBtn.textContent = 'Salvataggio...';
      try {
        await saveManualBlocks(currentAdminSelectedDates);
      } catch (err) {
        console.error('Save availability error:', err);
        showAdminMessage('Errore salvataggio.', 'error');
      } finally {
        saveBtn.disabled = false;
        saveBtn.textContent = 'Salva Modifiche';
      }
    });
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
