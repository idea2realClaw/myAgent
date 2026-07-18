/* ================================================================
   Brand Website - app.js
================================================================ */

(function () {
  'use strict';

  /* ── Navbar scroll effect ─────────────────────────── */
  const navbar = document.getElementById('navbar');
  function updateNav() {
    navbar.classList.toggle('scrolled', window.scrollY > 40);
  }
  window.addEventListener('scroll', updateNav, { passive: true });
  updateNav();

  /* ── Hamburger menu ───────────────────────────────── */
  const hamburger = document.getElementById('hamburger');
  const navLinks  = document.getElementById('navLinks');
  hamburger.addEventListener('click', function () {
    this.classList.toggle('open');
    navLinks.classList.toggle('open');
  });
  navLinks.querySelectorAll('a').forEach(function (a) {
    a.addEventListener('click', function () {
      hamburger.classList.remove('open');
      navLinks.classList.remove('open');
    });
  });

  /* ── Smooth scroll for anchor links ──────────────── */
  document.querySelectorAll('a[href^="#"]').forEach(function (a) {
    a.addEventListener('click', function (e) {
      var target = document.querySelector(this.getAttribute('href'));
      if (!target) return;
      e.preventDefault();
      var top = target.getBoundingClientRect().top + window.scrollY
                - parseInt(getComputedStyle(document.documentElement).getPropertyValue('--nav-height'));
      window.scrollTo({ top: top, behavior: 'smooth' });
    });
  });

  /* ── Intersection Observer: fade-in on scroll ────── */
  var observer = new IntersectionObserver(function (entries) {
    entries.forEach(function (entry) {
      if (entry.isIntersecting) {
        entry.target.classList.add('visible');
        observer.unobserve(entry.target);
      }
    });
  }, { threshold: 0.12 });

  document.querySelectorAll(
    '.service-card, .case-card, .about-card, .info-item'
  ).forEach(function (el) {
    el.classList.add('fade-in');
    observer.observe(el);
  });

  /* ── Contact form ─────────────────────────────────── */
  window.handleSubmit = function (e) {
    e.preventDefault();
    var btn = e.target.querySelector('[type="submit"]');
    btn.textContent = '提交成功 ✓';
    btn.style.background = 'var(--brand-secondary)';
    btn.disabled = true;
    setTimeout(function () {
      btn.textContent = '提交咨询';
      btn.style.background = '';
      btn.disabled = false;
      e.target.reset();
    }, 3000);
  };

  /* ── Number counter animation ─────────────────────── */
  function animateCounter(el) {
    var target = parseFloat(el.textContent);
    var suffix = el.textContent.replace(/[\d.]/g, '');
    var isFloat = el.textContent.includes('.');
    var start = 0;
    var duration = 1800;
    var startTime = null;
    function step(ts) {
      if (!startTime) startTime = ts;
      var progress = Math.min((ts - startTime) / duration, 1);
      var ease = 1 - Math.pow(1 - progress, 3);
      var val = start + (target - start) * ease;
      el.textContent = (isFloat ? val.toFixed(1) : Math.floor(val)) + suffix;
      if (progress < 1) requestAnimationFrame(step);
    }
    requestAnimationFrame(step);
  }

  var statsObserver = new IntersectionObserver(function (entries) {
    entries.forEach(function (entry) {
      if (entry.isIntersecting) {
        entry.target.querySelectorAll('.stat-num').forEach(animateCounter);
        statsObserver.unobserve(entry.target);
      }
    });
  }, { threshold: 0.5 });

  var heroStats = document.querySelector('.hero-stats');
  if (heroStats) statsObserver.observe(heroStats);

})();
