// loom-shared.js — runs on every loom page
// Handles: theme toggle (light/dark, persisted), live clock, footer
// counters, and keyboard nav between pages (g · c · p · r · t · ⇧t).
// Pages stamp their own active item via class="on" on the crumb.
'use strict';

(function () {
  // ---------------- theme toggle ----------------
  function setTheme(t) {
    document.documentElement.setAttribute('data-theme', t);
    try { localStorage.setItem('loom-theme', t); } catch (_) {}
    const btn = document.querySelector('.lm-theme-btn');
    if (btn) btn.textContent = t === 'dark' ? '☀ light' : '☾ dark';
  }
  window.lmToggleTheme = function () {
    const cur = document.documentElement.getAttribute('data-theme') || 'dark';
    setTheme(cur === 'dark' ? 'light' : 'dark');
  };

  // ---------------- live clock + counters ----------------
  function pad(n) { return String(n).padStart(2, '0'); }
  function fmtClock(d) { return pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds()); }
  function fmtUptime(s) {
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
    return pad(h) + ':' + pad(m) + ':' + pad(sec);
  }

  function tick() {
    const now = new Date();
    document.querySelectorAll('.lm-foot .clock').forEach(el => {
      el.textContent = fmtClock(now);
    });
    document.querySelectorAll('[data-uptime-start]').forEach(el => {
      const start = parseInt(el.dataset.uptimeStart, 10);
      el.textContent = fmtUptime(Math.max(0, Math.floor((Date.now() - start) / 1000)));
    });
  }

  // ---------------- keyboard nav ----------------
  const NAV = { g: '/', c: '/chat.html', p: '/game.html', r: '/_routes', t: '/_trace' };
  document.addEventListener('keydown', function (e) {
    // Don't intercept while user is typing into a field
    const tag = (e.target && e.target.tagName) || '';
    if (tag === 'INPUT' || tag === 'TEXTAREA' || e.target.isContentEditable) return;
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.shiftKey && e.key.toLowerCase() === 't') { window.lmToggleTheme(); e.preventDefault(); return; }
    const k = e.key.toLowerCase();
    if (NAV[k] && !e.shiftKey) { window.location.href = NAV[k]; }
  });

  // ---------------- wire up theme button + start clock ----------------
  function init() {
    const t = document.documentElement.getAttribute('data-theme') || 'dark';
    const btn = document.querySelector('.lm-theme-btn');
    if (btn) {
      btn.textContent = t === 'dark' ? '☀ light' : '☾ dark';
      btn.addEventListener('click', window.lmToggleTheme);
    }
    tick();
    setInterval(tick, 1000);
  }
  if (document.readyState !== 'loading') init();
  else document.addEventListener('DOMContentLoaded', init);
})();
