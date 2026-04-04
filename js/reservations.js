/**
 * reservations.js - Guest reservation form logic
 * VillaST - San Teodoro, Sardegna
 */

import { db } from './firebase-config.js';
import { collection, addDoc, serverTimestamp } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";
import { loadBookedDates, initGuestCalendar, dateRangeHasConflict } from './calendar.js';

function sanitizeString(str) { return String(str).trim(); }
function isValidEmail(email) { return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email); }
function isValidPhone(phone) { return /^\+?[\d\s\-()\u00B7]{7,30}$/.test(phone); }

function showMessage(el, html, type) {
  el.innerHTML = html;
  el.className = `form-message form-message--${type}`;
  el.style.display = 'block';
  el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function hideMessage(el) { el.style.display = 'none'; el.innerHTML = ''; }

document.addEventListener('DOMContentLoaded', async () => {
  const form = document.getElementById('reservation-form');
  const checkInEl = document.getElementById('checkin-date');
  const checkOutEl = document.getElementById('checkout-date');
  const nameEl = document.getElementById('guest-name');
  const emailEl = document.getElementById('guest-email');
  const phoneEl = document.getElementById('guest-phone');
  const countEl = document.getElementById('guest-count');
  const msgEl = document.getElementById('form-message');
  const loadingEl = document.getElementById('availability-loading');
  const submitBtn = form ? form.querySelector('[type="submit"]') : null;

  if (!form || !checkInEl || !checkOutEl) return;

  if (loadingEl) loadingEl.style.display = 'block';

  let bookedDates = new Set();
  try {
    bookedDates = await loadBookedDates(db);
  } catch (err) {
    console.warn('Could not load availability:', err);
  } finally {
    if (loadingEl) loadingEl.style.display = 'none';
  }

  initGuestCalendar(checkInEl, checkOutEl, bookedDates);

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    hideMessage(msgEl);

    const name = sanitizeString(nameEl.value);
    const email = sanitizeString(emailEl.value);
    const phone = sanitizeString(phoneEl.value);
    const guests = parseInt(countEl.value, 10);
    const checkIn = sanitizeString(checkInEl.value);
    const checkOut = sanitizeString(checkOutEl.value);

    if (!name || name.length < 2) { showMessage(msgEl, '<p>Inserisci nome e cognome.</p>', 'error'); nameEl.focus(); return; }
    if (name.length > 100) { showMessage(msgEl, '<p>Nome troppo lungo (max 100 caratteri).</p>', 'error'); return; }
    if (!isValidEmail(email)) { showMessage(msgEl, '<p>Email non valida.</p>', 'error'); emailEl.focus(); return; }
    if (!isValidPhone(phone)) { showMessage(msgEl, '<p>Telefono non valido.</p>', 'error'); phoneEl.focus(); return; }
    if (!guests || guests < 1 || guests > 20) { showMessage(msgEl, '<p>Seleziona il numero di ospiti.</p>', 'error'); return; }
    if (!checkIn) { showMessage(msgEl, '<p>Seleziona la data di arrivo.</p>', 'error'); return; }
    if (!checkOut) { showMessage(msgEl, '<p>Seleziona la data di partenza.</p>', 'error'); return; }
    if (checkOut <= checkIn) { showMessage(msgEl, '<p>La partenza deve essere dopo l arrivo.</p>', 'error'); return; }

    let freshBookedDates;
    try {
      freshBookedDates = await loadBookedDates(db);
    } catch (err) {
      console.error('Availability refresh error:', err);
      showMessage(msgEl, '<p>Errore nel controllo disponibilita. Riprova tra qualche istante.</p>', 'error');
      return;
    }

    if (dateRangeHasConflict(checkIn, checkOut, freshBookedDates)) {
      showMessage(msgEl, '<p>Date non disponibili. Seleziona date alternative.</p>', 'error');
      return;
    }

    if (submitBtn) { submitBtn.disabled = true; submitBtn.textContent = 'Invio...'; }

    try {
      await addDoc(collection(db, 'reservations'), {
        name, email, phone, guests, checkIn, checkOut,
        status: 'pending',
        createdAt: serverTimestamp()
      });

      form.style.display = 'none';
      form.reset();

      showMessage(msgEl, `
        <div>
          <h3>Richiesta inviata!</h3>
          <p>Grazie <strong>${name}</strong>! Riceverai conferma entro 24 ore.</p>
        </div>
      `, 'success');

    } catch (err) {
      console.error('Reservation submission error:', err);
      showMessage(msgEl, '<p>Errore nell invio. Riprova o contattaci su WhatsApp.</p>', 'error');
      if (submitBtn) { submitBtn.disabled = false; submitBtn.textContent = 'Richiedi Prenotazione'; }
    }
  });
});
