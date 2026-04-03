/**
 * app.js - Landing page animations and interactivity
 * VillaST - San Teodoro, Sardegna
 */

if (typeof AOS !== 'undefined') {
  AOS.init({ duration: 900, easing: 'ease-out-cubic', once: true, offset: 80, disable: 'phone' });
}

const navbar = document.getElementById('navbar');

function handleNavbarScroll() {
  if (!navbar) return;
  if (window.scrollY > 50) navbar.classList.add('navbar--scrolled');
  else navbar.classList.remove('navbar--scrolled');
}

window.addEventListener('scroll', handleNavbarScroll, { passive: true });
handleNavbarScroll();

const heroSection = document.getElementById('hero-section');
const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) && !window.MSStream;
const isSafari = /^((?!chrome|android).)*safari/i.test(navigator.userAgent);

if (heroSection && !isIOS && !isSafari) {
  window.addEventListener('scroll', () => {
    heroSection.style.backgroundPositionY = `calc(50% + ${window.scrollY * 0.35}px)`;
  }, { passive: true });
}

const navToggle = document.querySelector('.nav-toggle');
const mobileMenu = document.getElementById('mobile-menu');

if (navToggle && mobileMenu) {
  navToggle.addEventListener('click', () => {
    const isOpen = mobileMenu.classList.toggle('mobile-menu--open');
    navToggle.setAttribute('aria-expanded', isOpen ? 'true' : 'false');
    document.body.style.overflow = isOpen ? 'hidden' : '';
  });
  mobileMenu.querySelectorAll('a').forEach(link => {
    link.addEventListener('click', () => {
      mobileMenu.classList.remove('mobile-menu--open');
      navToggle.setAttribute('aria-expanded', 'false');
      document.body.style.overflow = '';
    });
  });
  document.addEventListener('click', (e) => {
    if (mobileMenu.classList.contains('mobile-menu--open') && !mobileMenu.contains(e.target) && !navToggle.contains(e.target)) {
      mobileMenu.classList.remove('mobile-menu--open');
      navToggle.setAttribute('aria-expanded', 'false');
      document.body.style.overflow = '';
    }
  });
}

document.querySelectorAll('a[href^="#"]').forEach(anchor => {
  anchor.addEventListener('click', (e) => {
    const targetId = anchor.getAttribute('href').slice(1);
    const target = document.getElementById(targetId);
    if (!target) return;
    e.preventDefault();
    target.scrollIntoView({ behavior: 'smooth', block: 'start' });
    history.pushState(null, '', `#${targetId}`);
  });
});

const langToggle = document.querySelector('.lang-toggle');

function applyLanguage(lang) {
  if (lang === 'en') {
    document.body.classList.add('lang-en');
    if (langToggle) langToggle.textContent = 'EN | IT';
  } else {
    document.body.classList.remove('lang-en');
    if (langToggle) langToggle.textContent = 'IT | EN';
  }
}

const savedLang = localStorage.getItem('villa-lang') || 'it';
applyLanguage(savedLang);

if (langToggle) {
  langToggle.addEventListener('click', () => {
    const currentLang = document.body.classList.contains('lang-en') ? 'en' : 'it';
    const newLang = currentLang === 'en' ? 'it' : 'en';
    applyLanguage(newLang);
    localStorage.setItem('villa-lang', newLang);
  });
}

const counterObserver = new IntersectionObserver((entries) => {
  entries.forEach(entry => {
    if (entry.isIntersecting) {
      const el = entry.target;
      const target = parseInt(el.dataset.target, 10);
      if (!isNaN(target)) {
        const startTime = performance.now();
        function update(currentTime) {
          const progress = Math.min((currentTime - startTime) / 1500, 1);
          const eased = 1 - Math.pow(1 - progress, 3);
          el.textContent = Math.round(target * eased) + (el.dataset.suffix || '');
          if (progress < 1) requestAnimationFrame(update);
        }
        requestAnimationFrame(update);
        counterObserver.unobserve(el);
      }
    }
  });
}, { threshold: 0.5 });

document.querySelectorAll('.stat-counter').forEach(el => counterObserver.observe(el));

const galleryImages = Array.from(document.querySelectorAll('.gallery__item img'));

if (galleryImages.length > 0) {
  const lightbox = document.createElement('div');
  lightbox.id = 'lightbox';
  lightbox.setAttribute('role', 'dialog');
  lightbox.setAttribute('aria-modal', 'true');
  lightbox.innerHTML = `
    <div class="lightbox__overlay"></div>
    <button class="lightbox__close" aria-label="Chiudi">&times;</button>
    <button class="lightbox__prev" aria-label="Precedente">&#8249;</button>
    <button class="lightbox__next" aria-label="Successiva">&#8250;</button>
    <div class="lightbox__content">
      <img class="lightbox__img" src="" alt="">
      <p class="lightbox__caption"></p>
    </div>
  `;
  document.body.appendChild(lightbox);

  const lbStyle = document.createElement('style');
  lbStyle.textContent = `
    #lightbox { display:none; position:fixed; inset:0; z-index:9999; align-items:center; justify-content:center; }
    #lightbox.lightbox--open { display:flex; }
    .lightbox__overlay { position:absolute; inset:0; background:rgba(0,0,0,0.92); }
    .lightbox__content { position:relative; z-index:1; max-width:90vw; max-height:90vh; text-align:center; }
    .lightbox__img { max-width:90vw; max-height:80vh; object-fit:contain; border-radius:8px; }
    .lightbox__caption { color:rgba(255,255,255,0.7); margin-top:0.75rem; font-size:0.9rem; }
    .lightbox__close,.lightbox__prev,.lightbox__next { position:absolute; z-index:2; background:rgba(255,255,255,0.1); border:1px solid rgba(255,255,255,0.2); color:white; cursor:pointer; border-radius:50%; width:48px; height:48px; font-size:1.5rem; display:flex; align-items:center; justify-content:center; transition:background 0.2s; }
    .lightbox__close:hover,.lightbox__prev:hover,.lightbox__next:hover { background:rgba(193,105,79,0.7); }
    .lightbox__close { top:1rem; right:1rem; }
    .lightbox__prev { left:1rem; top:50%; transform:translateY(-50%); }
    .lightbox__next { right:1rem; top:50%; transform:translateY(-50%); }
  `;
  document.head.appendChild(lbStyle);

  const lbImg = lightbox.querySelector('.lightbox__img');
  const lbCaption = lightbox.querySelector('.lightbox__caption');
  let currentIndex = 0;

  function openLightbox(index) {
    currentIndex = index;
    lbImg.src = galleryImages[index].src;
    lbImg.alt = galleryImages[index].alt;
    lbCaption.textContent = galleryImages[index].alt || '';
    lightbox.classList.add('lightbox--open');
    document.body.style.overflow = 'hidden';
  }

  function closeLightbox() {
    lightbox.classList.remove('lightbox--open');
    document.body.style.overflow = '';
  }

  function navigate(dir) {
    currentIndex = (currentIndex + dir + galleryImages.length) % galleryImages.length;
    lbImg.src = galleryImages[currentIndex].src;
    lbImg.alt = galleryImages[currentIndex].alt;
    lbCaption.textContent = galleryImages[currentIndex].alt || '';
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
