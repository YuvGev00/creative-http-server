'use strict';

// Renders the Flight Recorder timeline served at /_trace. Auto-refreshes so
// you can watch requests flow through the framework in real time.

function esc(s) {
  return String(s).replace(/[&<>"]/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])
  );
}

function statusColor(s) {
  if (s >= 500) return '#ff5630';
  if (s >= 400) return '#ffab00';
  if (s >= 300) return '#4c9aff';
  return '#36b37e';
}

function bar(steps) {
  const total = steps.reduce((a, s) => a + s.ms, 0) || 1;
  return steps
    .map((s) => {
      const pct = Math.max(2, (s.ms / total) * 100);
      return `<span class="seg" style="width:${pct}%" title="${esc(
        s.name
      )} — ${s.ms} ms">${esc(s.name)}</span>`;
    })
    .join('');
}

function renderHtml(entries) {
  const rows = entries
    .map(
      (e) => `
    <article class="row">
      <header>
        <span class="badge" style="background:${statusColor(e.status)}">${
        e.status
      }</span>
        <code class="m">${esc(e.method)}</code>
        <code class="p">${esc(e.path)}</code>
        <span class="t">${e.totalMs} ms · ${e.bytes} B</span>
      </header>
      <div class="meta">
        ${e.route ? `route <code>${esc(e.route)}</code> · ` : ''}
        ${
          e.validation
            ? `validation <strong class="${e.validation}">${e.validation}</strong> · `
            : ''
        }
        <span class="ts">${esc(e.time)}</span>
      </div>
      <div class="timeline">${bar(e.steps)}</div>
    </article>`
    )
    .join('');

  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8">
<title>Forge — Flight Recorder</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="refresh" content="3">
<style>
  :root { color-scheme: dark; }
  body { margin:0; font-family:-apple-system,Segoe UI,Roboto,sans-serif;
    background:#0d1117; color:#e6edf3; }
  header.top { padding:2rem 2rem 1rem; border-bottom:1px solid #21262d; }
  header.top h1 { margin:0; font-size:1.5rem; }
  header.top p { color:#8b949e; margin:.4rem 0 0; }
  .wrap { max-width:900px; margin:0 auto; padding:1.5rem 2rem 4rem; }
  .row { background:#161b22; border:1px solid #21262d; border-radius:10px;
    padding:.9rem 1.1rem; margin:.8rem 0; }
  .row header { display:flex; align-items:center; gap:.7rem; }
  .badge { color:#0d1117; font-weight:700; font-size:.72rem;
    padding:.2rem .5rem; border-radius:5px; }
  code { background:#21262d; padding:.1rem .4rem; border-radius:4px;
    font-family:ui-monospace,Menlo,monospace; font-size:.85rem; }
  .m { color:#9aa6b2; } .p { font-size:.95rem; }
  .t { margin-left:auto; color:#8b949e; font-size:.8rem; }
  .meta { color:#8b949e; font-size:.8rem; margin:.5rem 0; }
  .passed { color:#36b37e; } .failed { color:#ff5630; }
  .timeline { display:flex; height:22px; border-radius:5px; overflow:hidden;
    font-size:.68rem; }
  .seg { display:flex; align-items:center; justify-content:center;
    background:#243049; border-right:1px solid #0d1117; color:#cdd6e3;
    white-space:nowrap; overflow:hidden; padding:0 4px; }
  .seg:nth-child(even){ background:#2d3b57; }
  a { color:#4c9aff; }
  .empty { color:#8b949e; }
</style></head>
<body>
  <header class="top">
    <h1>⚒ Forge — Request Flight Recorder</h1>
    <p>Last ${entries.length} request(s), newest first · auto-refresh 3s ·
       <a href="/_trace?format=json">JSON</a> · <a href="/_routes">API docs</a></p>
  </header>
  <div class="wrap">
    ${rows || '<p class="empty">No requests recorded yet. Hit some routes, then refresh.</p>'}
  </div>
</body></html>`;
}

module.exports = { renderHtml };
