'use strict';

// Renders the Flight Recorder timeline at /_trace — loom-styled.
// Auto-refreshes so you can watch requests flow through the framework.

function esc(s) {
  return String(s).replace(/[&<>"]/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])
  );
}

function statusClass(s) {
  if (s >= 500) return 's5xx';
  if (s >= 400) return 's4xx';
  if (s >= 300) return 's3xx';
  return 's2xx';
}

// step name → bar color class
function stepClass(name, validation) {
  if (/validate/i.test(name)) return validation === 'failed' ? 'warn' : 'warn';
  if (/^handler$|render|sendfile/i.test(name)) return 'fire';
  if (/ws-handshake|upgrade/i.test(name)) return 'fire';
  return '';
}

function highlightPath(p) {
  return esc(p).replace(/(:[a-z]+)/gi, '<span class="param">$1</span>');
}

function fmtBytes(b) {
  if (b == null) return '—';
  if (b < 1024) return b + ' B';
  if (b < 1024 * 1024) return (b / 1024).toFixed(1) + ' kB';
  return (b / 1024 / 1024).toFixed(1) + ' MB';
}

// Round a millisecond value to a compact label: sub-1ms keeps 2 decimals,
// otherwise 1 decimal (drops a trailing .0). Avoids long float tails like
// "0.11700000003ms" overflowing the legend / axis.
function fmtMs(ms) {
  const n = Number(ms) || 0;
  if (n < 1) return n.toFixed(2).replace(/\.?0+$/, '') || '0';
  return n.toFixed(1).replace(/\.0$/, '');
}

function pickTicks(total) {
  // 2–3 evenly-spaced ticks across the bar, never the leading 0 (it sits at
  // the very left edge and gets clipped by the translateX(-50%) centering).
  if (total <= 0) return [];
  return [total / 2, total];
}

function renderRow(e) {
  const total = (e.steps || []).reduce((a, s) => a + (s.ms || 0), 0) || 1;
  const ticks = pickTicks(total);
  const segs = (e.steps || []).map((s) =>
    `<span class="seg ${stepClass(s.name, e.validation)}" title="${esc(s.name)} — ${fmtMs(s.ms)} ms" style="flex-basis:${Math.max(1, (s.ms / total) * 100)}%"></span>`
  ).join('');
  const legend = (e.steps || []).map((s) =>
    `<span>${esc(s.name)} <b>${fmtMs(s.ms)}ms</b></span>`
  ).join('');
  const axis = ticks.map((t) =>
    `<i style="left:${(t / total) * 100}%"></i><span style="left:${(t / total) * 100}%">${fmtMs(t)}ms</span>`
  ).join('');

  return (
    '<div class="lm-trace-row">' +
      '<div class="top">' +
        `<span class="s ${statusClass(e.status)}">${e.status}</span>` +
        `<span class="m">${esc(e.method)}</span>` +
        `<span class="p">${highlightPath(e.path)}</span>` +
        `<span class="ms">${fmtMs(e.totalMs)} ms</span>` +
        `<span class="b">${esc(typeof e.bytes === 'number' ? fmtBytes(e.bytes) : (e.bytes || '—'))}</span>` +
        `<span class="ts">${esc(e.time)}</span>` +
      '</div>' +
      `<div class="bar">${segs}</div>` +
      `<div class="axis">${axis}</div>` +
      `<div class="legend">${legend}</div>` +
    '</div>'
  );
}

function renderHtml(entries) {
  const safe = Array.isArray(entries) ? entries : [];
  const rows = safe.length ? safe.map(renderRow).join('') : '';
  const total = safe.length;
  const errors = safe.filter((e) => e.status >= 400).length;
  const validations = safe.filter((e) => e.validation).length;

  // p50 / p99
  const times = safe.map((e) => e.totalMs).filter((n) => typeof n === 'number').sort((a, b) => a - b);
  const pct = (p) => times.length ? times[Math.min(times.length - 1, Math.floor((p / 100) * times.length))] : 0;
  const p50 = pct(50);
  const p99 = pct(99);

  return `<!DOCTYPE html>
<html lang="en" data-theme="dark">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="refresh" content="3">
<title>loom — flight recorder</title>
<link rel="icon" href="./loom.svg" type="image/svg+xml">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500;600;700;800&display=swap" rel="stylesheet">
<link rel="stylesheet" href="./loom.css">
<script>(function(){try{document.documentElement.setAttribute('data-theme', localStorage.getItem('loom-theme') || 'dark');}catch(e){}})();</script>
</head>
<body>

<header class="lm-bar">
  <div class="mark">
    <svg viewBox="0 0 28 28" width="26" height="26" aria-hidden="true">
      <line x1="5" y1="2" x2="5" y2="26" stroke="currentColor" stroke-width="1.6" stroke-linecap="square"/>
      <line x1="11" y1="2" x2="11" y2="26" stroke="currentColor" stroke-width="1.6" stroke-linecap="square"/>
      <line x1="17" y1="2" x2="17" y2="26" stroke="currentColor" stroke-width="1.6" stroke-linecap="square"/>
      <line x1="23" y1="2" x2="23" y2="26" stroke="currentColor" stroke-width="1.6" stroke-linecap="square"/>
      <g stroke="currentColor" stroke-width="1.4" opacity="0.45" stroke-linecap="square">
        <line x1="1" y1="8" x2="4" y2="8"/><line x1="6" y1="8" x2="10" y2="8"/><line x1="12" y1="8" x2="16" y2="8"/><line x1="18" y1="8" x2="22" y2="8"/><line x1="24" y1="8" x2="27" y2="8"/>
        <line x1="1" y1="20" x2="4" y2="20"/><line x1="6" y1="20" x2="10" y2="20"/><line x1="12" y1="20" x2="16" y2="20"/><line x1="18" y1="20" x2="22" y2="20"/><line x1="24" y1="20" x2="27" y2="20"/>
      </g>
      <line class="lm-mark-accent" x1="0" y1="14" x2="28" y2="14" stroke-width="2.4" stroke-linecap="square"/>
    </svg>
    <span class="nm">loom</span>
    <span class="sub">// weaves <b>http/1.1</b> from raw net</span>
  </div>
  <nav class="crumbs">
    <a href="/"><span class="kbd">[g]</span>index</a>
    <a href="/chat.html"><span class="kbd">[c]</span>chat</a>
    <a href="/game.html"><span class="kbd">[p]</span>game</a>
    <a href="/_routes"><span class="kbd">[r]</span>routes</a>
    <a href="/_trace" class="on"><span class="kbd">[t]</span>trace</a>
  </nav>
  <div class="meta">
    <span>:3000</span>
    <span class="live"><span class="pulse"></span>recording</span>
    <button class="lm-theme-btn" type="button">☀ light</button>
  </div>
</header>

<main class="lm-stage">

  <div class="lm-trace-head">
    <div>
      <h2>flight recorder</h2>
      <p class="sub">
        Bounded ring buffer of recent requests with <b>per-middleware</b> timing, validation pass/fail, final status and body size. Auto-refreshes <b>every 3s</b> · newest first.
      </p>
    </div>
    <a class="json" href="/_trace?format=json" style="font-size:11px; padding:6px 10px; border:1px solid var(--rule); color:var(--green); font-weight:700; text-decoration:none">json ↗</a>
  </div>

  <div class="lm-trace-grid">
    <div><div class="k">entries</div><div class="v">${total}</div></div>
    <div><div class="k">p50</div><div class="v green">${fmtMs(p50)}<small>ms</small></div></div>
    <div><div class="k">p99</div><div class="v">${fmtMs(p99)}<small>ms</small></div></div>
    <div><div class="k">errors</div><div class="v hot">${String(errors).padStart(2, '0')}</div></div>
    <div><div class="k">validations</div><div class="v">${validations}</div></div>
  </div>

  <div class="lm-trace-headers">
    <span>status</span><span>method</span><span>path · timeline</span><span>time</span><span>size</span><span>at</span>
  </div>
  ${rows
    ? `<div class="lm-trace-list">${rows}</div>`
    : `<div class="lm-empty">no requests recorded yet · hit some routes, then wait for the 3s refresh.</div>`
  }

</main>

<footer class="lm-foot">
  <span class="badge">loom 0.1</span>
  <span><span class="muted">cwd</span> <span style="color:var(--ink)">/_trace</span></span>
  <span><span class="muted">entries</span> <b style="color:var(--ink)">${total}</b></span>
  <span><span class="muted">errors</span> <b style="color:var(--ink)">${errors}</b></span>
  <span><span class="muted">clock</span> <span class="clock">--:--:--</span></span>
  <span class="spacer"></span>
  <span class="kbd-hints">nav <b>g</b> <b>c</b> <b>p</b> <b>r</b> <b>t</b> · theme <b>⇧t</b></span>
</footer>

<script src="./loom-shared.js"></script>
</body>
</html>`;
}

module.exports = { renderHtml };
