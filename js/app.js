/**
 * app.js — Landing page behaviour
 * VillaST — San Teodoro, Sardegna
 *
 * Two languages ship as two URLs (/ and /en/, see tools/build-en.mjs), so there is
 * no client-side language toggle here any more: the active language is decided by
 * `body.lang-en`, which the build sets on the English page.
 */

import { db } from './firebase-config.js';
import { doc, getDoc } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";
import { normalizePricing, applyHomepagePricing } from './pricing.js';

// ─── Reveal on scroll ──────────────────────────────────────────────────────
// Replaces the AOS library (it was 2 CDN requests + 900ms animations for this).
// The markup API stays `data-aos` / `data-aos-delay`; the hidden start state is
// scoped to `html.js`, set by the inline script in <head>, so a dead JS bundle
// degrades to "everything visible" instead of a blank page.

function initReveal() {
  const items = Array.from(document.querySelectorAll('[data-aos]'));
  if (items.length === 0) return;

  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (reduceMotion || !('IntersectionObserver' in window)) {
    items.forEach(el => el.classList.add('is-visible'));
    return;
  }

  const observer = new IntersectionObserver((entries) => {
    entries.forEach(entry => {
      if (!entry.isIntersecting) return;
      const el = entry.target;
      const delay = parseInt(el.dataset.aosDelay || '0', 10) || 0;
      window.setTimeout(() => el.classList.add('is-visible'), delay);
      observer.unobserve(el);
    });
  }, { rootMargin: '0px 0px -8% 0px', threshold: 0.08 });

  items.forEach(el => observer.observe(el));
}

initReveal();

// ─── Navbar scroll effect ──────────────────────────────────────────────────

const navbar = document.getElementById('navbar');

function handleNavbarScroll() {
  if (!navbar) return;
  navbar.classList.toggle('navbar--scrolled', window.scrollY > 50);
}

window.addEventListener('scroll', handleNavbarScroll, { passive: true });
handleNavbarScroll();

// ─── Sticky booking bar ────────────────────────────────────────────────────
// Visible after the hero, parked while the booking form or the footer is on screen
// (the footer holds the WhatsApp CTA, the bar must not sit on top of it).

function initBookingBar() {
  const bar = document.getElementById('booking-bar');
  const hero = document.getElementById('hero-section');
  if (!bar || !hero) return;

  const parked = [document.getElementById('reservation'), document.querySelector('.footer')]
    .filter(Boolean);
  let ticking = false;

  function update() {
    ticking = false;
    const pastHero = hero.getBoundingClientRect().bottom <= 0;
    const overlaps = parked.some(el => {
      const rect = el.getBoundingClientRect();
      return rect.top < window.innerHeight * 0.75 && rect.bottom > 0;
    });
    bar.classList.toggle('is-visible', pastHero && !overlaps);
  }

  function schedule() {
    if (ticking) return;
    ticking = true;
    requestAnimationFrame(update);
  }

  window.addEventListener('scroll', schedule, { passive: true });
  window.addEventListener('resize', schedule, { passive: true });
  update();
}

initBookingBar();

// ─── Mobile menu ───────────────────────────────────────────────────────────

const navToggle = document.querySelector('.nav-toggle');
const mobileMenu = document.getElementById('mobile-menu');

if (navToggle && mobileMenu) {
  function closeMenu() {
    mobileMenu.classList.remove('active');
    navToggle.setAttribute('aria-expanded', 'false');
    document.body.style.overflow = '';
  }

  navToggle.addEventListener('click', () => {
    const isOpen = mobileMenu.classList.toggle('active');
    navToggle.setAttribute('aria-expanded', isOpen ? 'true' : 'false');
    // Prevent body scroll when menu is open
    document.body.style.overflow = isOpen ? 'hidden' : '';
  });

  // Close mobile menu when a link is clicked
  mobileMenu.querySelectorAll('a').forEach(link => {
    link.addEventListener('click', closeMenu);
  });

  // Close on outside click
  document.addEventListener('click', (e) => {
    if (
      mobileMenu.classList.contains('active') &&
      !mobileMenu.contains(e.target) &&
      !navToggle.contains(e.target)
    ) {
      closeMenu();
    }
  });
}

// ─── Smooth scroll (Safari polyfill) ──────────────────────────────────────

document.querySelectorAll('a[href^="#"]').forEach(anchor => {
  anchor.addEventListener('click', (e) => {
    const targetId = anchor.getAttribute('href').slice(1);
    const target = targetId && document.getElementById(targetId);
    if (!target) return;
    e.preventDefault();
    target.scrollIntoView({ behavior: 'smooth', block: 'start' });
    // Update URL hash without triggering jump
    history.pushState(null, '', `#${targetId}`);
  });
});

// ─── Number counter animation ──────────────────────────────────────────────

function animateCounter(el, target, duration = 1500) {
  const startTime = performance.now();

  function update(currentTime) {
    const progress = Math.min((currentTime - startTime) / duration, 1);
    // Ease out cubic
    const eased = 1 - Math.pow(1 - progress, 3);
    el.textContent = Math.round(target * eased) + (el.dataset.suffix || '');
    if (progress < 1) requestAnimationFrame(update);
  }

  requestAnimationFrame(update);
}

const counterObserver = new IntersectionObserver((entries) => {
  entries.forEach(entry => {
    if (!entry.isIntersecting) return;
    const el = entry.target;
    const target = parseInt(el.dataset.target, 10);
    if (!isNaN(target)) {
      animateCounter(el, target);
      counterObserver.unobserve(el);
    }
  });
}, { threshold: 0.5 });

document.querySelectorAll('.stat-counter').forEach(el => {
  counterObserver.observe(el);
});

// ─── Gallery Lightbox ──────────────────────────────────────────────────────
// Styling lives in css/style.css (.lightbox*) so it caches with the rest.

const galleryImages = Array.from(document.querySelectorAll('.gallery__item img'));

if (galleryImages.length > 0) {
  const lightbox = document.createElement('div');
  lightbox.id = 'lightbox';
  lightbox.className = 'lightbox';
  lightbox.setAttribute('role', 'dialog');
  lightbox.setAttribute('aria-modal', 'true');
  lightbox.setAttribute('aria-label', 'Gallery');
  lightbox.innerHTML = `
    <div class="lightbox__overlay"></div>
    <button class="lightbox__close" aria-label="Close">&times;</button>
    <button class="lightbox__prev" aria-label="Previous">&#8249;</button>
    <button class="lightbox__next" aria-label="Next">&#8250;</button>
    <div class="lightbox__content">
      <img class="lightbox__img" src="" alt="">
      <p class="lightbox__caption"></p>
    </div>
  `;
  document.body.appendChild(lightbox);

  const lbImg = lightbox.querySelector('.lightbox__img');
  const lbCaption = lightbox.querySelector('.lightbox__caption');
  let currentIndex = 0;
  let lastFocused = null;

  function show(index) {
    currentIndex = index;
    const img = galleryImages[index];
    // data-alt-en is the English alt text; build-en.mjs makes `alt` itself the
    // active-language one, so the lightbox just reuses it.
    lbImg.src = img.getAttribute('src');
    lbImg.alt = img.getAttribute('alt') || '';
    lbCaption.textContent = img.getAttribute('alt') || '';
  }

  function openLightbox(index) {
    lastFocused = document.activeElement;
    show(index);
    lightbox.classList.add('lightbox--open');
    document.body.style.overflow = 'hidden';
    lightbox.querySelector('.lightbox__close').focus();
  }

  function closeLightbox() {
    lightbox.classList.remove('lightbox--open');
    document.body.style.overflow = '';
    if (lastFocused) lastFocused.focus();
  }

  function navigate(dir) {
    show((currentIndex + dir + galleryImages.length) % galleryImages.length);
  }

  galleryImages.forEach((img, index) => {
    img.style.cursor = 'zoom-in';
    img.addEventListener('click', () => openLightbox(index));
  });

  lightbox.querySelector('.lightbox__close').addEventListener('click', closeLightbox);
  lightbox.querySelector('.lightbox__overlay').addEventListener('click', closeLightbox);
  lightbox.querySelector('.lightbox__prev').addEventListener('click', () => navigate(-1));
  lightbox.querySelector('.lightbox__next').addEventListener('click', () => navigate(1));

  document.addEventListener('keydown', (e) => {
    if (!lightbox.classList.contains('lightbox--open')) return;
    if (e.key === 'Escape') closeLightbox();
    if (e.key === 'ArrowLeft') navigate(-1);
    if (e.key === 'ArrowRight') navigate(1);
  });
}

// ─── Live pricing ──────────────────────────────────────────────────────────
// The static HTML carries the fallback values (they also serve no-JS); when
// `pricing/config` exists the cards and the sticky bar show the host's real
// prices. A missing doc or a failed read keeps the static values, silently.
getDoc(doc(db, 'pricing', 'config'))
  .then((snap) => { if (snap.exists()) applyHomepagePricing(normalizePricing(snap.data())); })
  .catch((err) => console.warn('Pricing config unavailable, keeping static prices:', err));
