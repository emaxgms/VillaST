/**
 * admin.js - Admin dashboard logic
 * VillaST - San Teodoro, Sardegna
 */

import { db, auth } from './firebase-config.js';
import { loadBookedDates, initAdminCalendar, formatDateISO, saveAvailability } from './calendar.js';
import {
  signInWithEmailAndPassword,
  signOut,
  onAuthStateChanged
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js";
import {
  collection,
  onSnapshot,
  getDoc,
  setDoc,
  updateDoc,
  deleteDoc,
  doc,
  query,
  orderBy
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";

let unsubscribeReservations = null;
let adminCalendarInstance = null;
let originalBookedDates = new Set();
let currentAdminSelectedDates = [];

function getDatesInRange(checkIn, checkOut) {
  const dates = [];
  if (!checkIn || !checkOut) return dates;
  const current = new Date(checkIn + 'T00:00:00');
  const end = new Date(checkOut + 'T00:00:00');
  while (current < end) {
    dates.push(formatDateISO(current));
    current.setDate(current.getDate() + 1);
  }
  return dates;
}

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
  const labels = { pending: 'In attesa', confirmed: 'Confermata', rejected: 'Rifiutata' };
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

function renderReservations(docs, filterStatus = '') {
  const tbody = document.getElementById('reservations-tbody');
  if (!tbody) return;

  const filtered = filterStatus ? docs.filter(d => d.data().status === filterStatus) : docs;

  const allData = docs.map(d => d.data());
  const pendingCount = allData.filter(d => d.status === 'pending').length;
  const confirmedCount = allData.filter(d => d.status === 'confirmed').length;
  const pendingChip = document.querySelector('.stat-chip--pending');
  const confirmedChip = document.querySelector('.stat-chip--confirmed');
  if (pendingChip) pendingChip.textContent = `${pendingCount} In attesa`;
  if (confirmedChip) confirmedChip.textContent = `${confirmedCount} Confermate`;

  if (filtered.length === 0) {
    tbody.innerHTML = `<tr class="empty-row"><td colspan="6">Nessuna prenotazione trovata</td></tr>`;
    return;
  }

  tbody.innerHTML = filtered.map(docSnap => {
    const d = docSnap.data();
    const id = docSnap.id;
    const badgeClass = `badge badge--${d.status}`;
    return `
      <tr data-id="${id}">
        <td><strong>${escapeHtml(d.name || '-')}</strong></td>
        <td><a href="mailto:${escapeHtml(d.email || '')}">${escapeHtml(d.email || '-')}</a><br><small>${escapeHtml(d.phone || '-')}</small></td>
        <td>${formatDateDisplay(d.checkIn)} - ${formatDateDisplay(d.checkOut)}</td>
        <td>${d.guests || '-'}</td>
        <td><span class="${badgeClass}">${statusLabel(d.status)}</span></td>
        <td class="action-cell">
          ${d.status !== 'confirmed' ? `<button class="btn-action btn-confirm" data-id="${id}">Conferma</button>` : ''}
          ${d.status !== 'rejected' ? `<button class="btn-action btn-reject" data-id="${id}">Rifiuta</button>` : ''}
          <button class="btn-action btn-delete" data-id="${id}">Elimina</button>
        </td>
      </tr>`;
  }).join('');

  tbody.querySelectorAll('.btn-confirm').forEach(btn => {
    btn.addEventListener('click', () => updateReservationStatus(btn.dataset.id, 'confirmed'));
  });
  tbody.querySelectorAll('.btn-reject').forEach(btn => {
    btn.addEventListener('click', () => updateReservationStatus(btn.dataset.id, 'rejected'));
  });
  tbody.querySelectorAll('.btn-delete').forEach(btn => {
    btn.addEventListener('click', () => deleteReservation(btn.dataset.id));
  });
}

async function updateReservationStatus(id, status) {
  try {
    const reservationRef = doc(db, 'reservations', id);
    const reservationSnap = await getDoc(reservationRef);

    if (!reservationSnap.exists()) {
      showAdminMessage('Prenotazione non trovata.', 'error');
      return;
    }

    const reservationData = reservationSnap.data();
    const checkIn = reservationData.checkIn;
    const checkOut = reservationData.checkOut;
    const oldStatus = reservationData.status;
    const dates = getDatesInRange(checkIn, checkOut);

    if (status === 'confirmed') {
      const bookedDates = await loadBookedDates(db);
      const hasConflict = dates.some(d => bookedDates.has(d));
      if (hasConflict) {
        const shouldOverride = confirm('Alcune date risultano gia bloccate. Vuoi confermare comunque la prenotazione?');
        if (!shouldOverride) return;
      }

      await Promise.all(dates.map(d => setDoc(doc(db, 'availability', d), { type: 'blocked' })));
    }

    if (status === 'rejected' && oldStatus === 'confirmed') {
      await Promise.all(dates.map(d => deleteDoc(doc(db, 'availability', d))));
    }

    await updateDoc(doc(db, 'reservations', id), { status });
    showAdminMessage(`Prenotazione ${status === 'confirmed' ? 'confermata' : 'rifiutata'}.`, 'success');
  } catch (err) {
    console.error('Update error:', err);
    showAdminMessage('Errore durante aggiornamento.', 'error');
  }
}

async function deleteReservation(id) {
  if (!confirm('Eliminare questa prenotazione?')) return;
  try {
    await deleteDoc(doc(db, 'reservations', id));
    showAdminMessage('Prenotazione eliminata.', 'success');
  } catch (err) {
    console.error('Delete error:', err);
    showAdminMessage('Errore eliminazione.', 'error');
  }
}

function startReservationsListener() {
  const q = query(collection(db, 'reservations'), orderBy('createdAt', 'desc'));
  const filterSelect = document.getElementById('filter-status');
  let allDocs = [];

  unsubscribeReservations = onSnapshot(q, (snapshot) => {
    allDocs = snapshot.docs;
    renderReservations(allDocs, filterSelect ? filterSelect.value : '');
  }, (err) => {
    console.error('Reservations listener error:', err);
    showAdminMessage('Errore caricamento prenotazioni.', 'error');
  });

  if (filterSelect) {
    filterSelect.addEventListener('change', () => renderReservations(allDocs, filterSelect.value));
  }
}

function stopReservationsListener() {
  if (unsubscribeReservations) { unsubscribeReservations(); unsubscribeReservations = null; }
}

async function initAdminCalendarSection() {
  const calendarEl = document.getElementById('admin-calendar');
  if (!calendarEl) return;

  try { originalBookedDates = await loadBookedDates(db); }
  catch (err) { console.error('Failed to load booked dates:', err); originalBookedDates = new Set(); }

  adminCalendarInstance = initAdminCalendar(calendarEl, originalBookedDates, (selectedDates) => {
    currentAdminSelectedDates = selectedDates;
  });
  currentAdminSelectedDates = Array.from(originalBookedDates).map(d => new Date(d + 'T00:00:00'));

  const saveBtn = document.getElementById('save-availability-btn');
  if (saveBtn) {
    saveBtn.addEventListener('click', async () => {
      saveBtn.disabled = true;
      saveBtn.textContent = 'Salvataggio...';
      try {
        await saveAvailability(db, originalBookedDates, currentAdminSelectedDates);
        originalBookedDates = new Set(currentAdminSelectedDates.map(formatDateISO));
        showAdminMessage('Disponibilita aggiornata!', 'success');
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
      if (panelName === 'calendar' && !adminCalendarInstance) initAdminCalendarSection();
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
