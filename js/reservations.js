/**
 * reservations.js - Guest reservation form logic
 * VillaST - San Teodoro, Sardegna
 */

import { db } from './firebase-config.js';
import { collection, addDoc, serverTimestamp } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";
import { loadBookedDates, initGuestCalendar, dateRangeHasConflict, formatDateISO } from './calendar.js';

function sanitizeString(str) { return String(str).trim(); }
function isValidEmail(email) { return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email); }
function isValidPhone(phone) { return /^\+?[\d\s\-()\u00B7]{7,30}$/.test(phone); }

// Bilingual helper: picks the string for the active locale.
function t(it, en) {
  return document.body.classList.contains('lang-en') ? en : it;
}

function showMessage(el, html, type) {
  el.innerHTML = html;
  el.className = `form-message form-message--${type}`;
  el.style.display = 'block';
  el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function hideMessage(el) { el.style.display = 'none'; el.innerHTML = ''; }

function getSelectedDateValues(checkInEl, checkOutEl) {
  let checkIn = sanitizeString(checkInEl.value);
  let checkOut = sanitizeString(checkOutEl.value);

  if (checkIn.includes(' to ')) {
    const [start, end] = checkIn.split(' to ').map(v => sanitizeString(v));
    if (start) checkIn = start;
    if (!checkOut && end) checkOut = end;
  }

  const fp = checkInEl._flatpickr;
  if (fp && Array.isArray(fp.selectedDates)) {
    if (fp.selectedDates[0]) checkIn = formatDateISO(fp.selectedDates[0]);
    if (fp.selectedDates[1]) checkOut = formatDateISO(fp.selectedDates[1]);
  }

  return { checkIn, checkOut };
}

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
    const { checkIn, checkOut } = getSelectedDateValues(checkInEl, checkOutEl);

    if (!name || name.length < 2) { showMessage(msgEl, `<p>${t('Inserisci nome e cognome.', 'Enter your full name.')}</p>`, 'error'); nameEl.focus(); return; }
    if (name.length > 100) { showMessage(msgEl, `<p>${t('Nome troppo lungo (max 100 caratteri).', 'Name too long (max 100 characters).')}</p>`, 'error'); return; }
    if (!isValidEmail(email)) { showMessage(msgEl, `<p>${t('Email non valida.', 'Invalid email address.')}</p>`, 'error'); emailEl.focus(); return; }
    if (!isValidPhone(phone)) { showMessage(msgEl, `<p>${t('Telefono non valido.', 'Invalid phone number.')}</p>`, 'error'); phoneEl.focus(); return; }
    if (!guests || guests < 1 || guests > 20) { showMessage(msgEl, `<p>${t('Seleziona il numero di ospiti.', 'Select the number of guests.')}</p>`, 'error'); return; }
    if (!checkIn) { showMessage(msgEl, `<p>${t('Seleziona la data di arrivo.', 'Select the check-in date.')}</p>`, 'error'); return; }
    if (!checkOut) { showMessage(msgEl, `<p>${t('Seleziona la data di partenza.', 'Select the check-out date.')}</p>`, 'error'); return; }
    if (checkOut <= checkIn) { showMessage(msgEl, `<p>${t('La partenza deve essere dopo l\u2019arrivo.', 'Check-out must be after check-in.')}</p>`, 'error'); return; }

    // Re-check availability against freshly persisted data before creating.
    let freshBookedDates;
    try {
      freshBookedDates = await loadBookedDates(db);
    } catch (err) {
      console.error('Availability refresh error:', err);
      showMessage(msgEl, `<p>${t('Errore nel controllo disponibilità. Riprova tra qualche istante.', 'Error checking availability. Please try again shortly.')}</p>`, 'error');
      return;
    }

    if (dateRangeHasConflict(checkIn, checkOut, freshBookedDates)) {
      showMessage(msgEl, `<p>${t('Date non disponibili. Seleziona date alternative.', 'Those dates are unavailable. Please pick alternative dates.')}</p>`, 'error');
      return;
    }

    if (submitBtn) { submitBtn.disabled = true; submitBtn.textContent = t('Invio...', 'Sending...'); }

    try {
      await addDoc(collection(db, 'reservations'), {
        source: 'guest',
        name, email, phone, guests, checkIn, checkOut,
        status: 'pending',
        createdAt: serverTimestamp()
      });

      form.style.display = 'none';
      form.reset();

      showMessage(msgEl, `
        <div>
          <h3>${t('Richiesta inviata!', 'Request sent!')}</h3>
          <p>${t(`Grazie <strong>${name}</strong>! Riceverai conferma entro 24 ore.`, `Thank you <strong>${name}</strong>! You will receive confirmation within 24 hours.`)}</p>
        </div>
      `, 'success');

    } catch (err) {
      console.error('Reservation submission error:', err);
      showMessage(msgEl, `<p>${t('Errore nell\u2019invio. Riprova o contattaci su WhatsApp.', 'Error submitting. Please try again or contact us on WhatsApp.')}</p>`, 'error');
      if (submitBtn) { submitBtn.disabled = false; submitBtn.textContent = t('Richiedi Prenotazione', 'Request Booking'); }
    }
  });
});
