/**
 * Main site interactions:
 *   - Rhino container parallax (3D ASCII render handled by ascii-renderer.js)
 *   - Cursor glow follow
 *   - Project card radial hover
 *   - Scroll-triggered fade-in animations
 *   - Smooth scroll for anchor links
 *   - Header background on scroll
 */

(function () {
  'use strict';

  // ─── Cursor Glow ──────────────────────────────────────────────

  const cursorGlow = document.getElementById('cursor-glow');
  let mouseX = 0;
  let mouseY = 0;
  let glowX = 0;
  let glowY = 0;

  if (cursorGlow && window.matchMedia('(pointer: fine)').matches) {
    document.addEventListener('mousemove', (e) => {
      mouseX = e.clientX;
      mouseY = e.clientY;
    });

    function animateGlow () {
      glowX += (mouseX - glowX) * 0.12;
      glowY += (mouseY - glowY) * 0.12;
      cursorGlow.style.left = glowX + 'px';
      cursorGlow.style.top = glowY + 'px';
      requestAnimationFrame(animateGlow);
    }

    animateGlow();
  } else if (cursorGlow) {
    cursorGlow.style.display = 'none';
  }

  // ─── Project Card Radial Hover ─────────────────────────────────

  document.querySelectorAll('.project-card').forEach((card) => {
    card.addEventListener('mousemove', (e) => {
      const rect = card.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;
      card.style.setProperty('--mouse-x', x + 'px');
      card.style.setProperty('--mouse-y', y + 'px');
    });
  });

  // ─── Scroll Fade-In Animations ─────────────────────────────────

  const fadeTargets = document.querySelectorAll(
    '.section-header, .about-text, .about-details, .project-card, ' +
    '.experience-item, .contact-content, .hero-content'
  );

  fadeTargets.forEach((el) => el.classList.add('fade-in'));

  const observer = new IntersectionObserver(
    (entries) => {
      entries.forEach((entry) => {
        if (entry.isIntersecting) {
          entry.target.classList.add('visible');
          observer.unobserve(entry.target);
        }
      });
    },
    { threshold: 0.15, rootMargin: '0px 0px -40px 0px' }
  );

  fadeTargets.forEach((el) => observer.observe(el));

  // ─── Staggered animation for grid items ────────────────────────

  const staggerGroups = [
    document.querySelectorAll('.project-card'),
    document.querySelectorAll('.experience-item'),
  ];

  staggerGroups.forEach((group) => {
    group.forEach((el, i) => {
      el.style.transitionDelay = (i * 0.1) + 's';
    });
  });

  // ─── Header scroll effect ─────────────────────────────────────

  const header = document.getElementById('site-header');
  let lastScroll = 0;

  window.addEventListener('scroll', () => {
    const scrollY = window.scrollY;
    if (scrollY > 100) {
      header.style.borderBottomColor = 'rgba(255,255,255,0.08)';
    } else {
      header.style.borderBottomColor = 'rgba(255,255,255,0.05)';
    }
    lastScroll = scrollY;
  }, { passive: true });

  // ─── Smooth scroll for nav links ──────────────────────────────

  document.querySelectorAll('a[href^="#"]').forEach((anchor) => {
    anchor.addEventListener('click', (e) => {
      const target = document.querySelector(anchor.getAttribute('href'));
      if (target) {
        e.preventDefault();
        const offset = header.offsetHeight;
        const top = target.getBoundingClientRect().top + window.scrollY - offset;
        window.scrollTo({ top, behavior: 'smooth' });
      }
    });
  });

  // ─── Active nav highlighting ──────────────────────────────────

  const sections = document.querySelectorAll('section[id]');
  const navLinks = document.querySelectorAll('nav a');

  const sectionObserver = new IntersectionObserver(
    (entries) => {
      entries.forEach((entry) => {
        if (entry.isIntersecting) {
          const id = entry.target.getAttribute('id');
          navLinks.forEach((link) => {
            link.style.color = link.getAttribute('href') === '#' + id
              ? 'var(--fg)'
              : '';
          });
        }
      });
    },
    { threshold: 0.3, rootMargin: '-60px 0px -40% 0px' }
  );

  sections.forEach((section) => sectionObserver.observe(section));
})();
