'use strict';

// Renders the live, self-updating API documentation served at /_routes.
// Reads route metadata the Router collected so docs can never drift from
// the actual implementation.

function collectRoutes(router) {
  return router.routes
    .filter((r) => !r.meta.hidden)
    .map((r) => ({
      method: r.method,
      path: r.pattern,
      params: r.paramNames.filter((p) => p !== 'wildcard'),
      description: r.meta.description || '',
      bodySchema: r.meta.bodySchema || null,
    }));
}

function renderJson(router) {
  return { service: 'Forge HTTP', routes: collectRoutes(router) };
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])
  );
}

function schemaRows(schema) {
  if (!schema) return '<em class="muted">no body</em>';
  return (
    '<table class="schema"><tr><th>field</th><th>type</th><th>rules</th></tr>' +
    Object.entries(schema)
      .map(([field, rule]) => {
        const rules = [];
        if (rule.required) rules.push('required');
        if (rule.min !== undefined) rules.push(`min ${rule.min}`);
        if (rule.max !== undefined) rules.push(`max ${rule.max}`);
        if (rule.enum) rules.push(`enum [${rule.enum.join(', ')}]`);
        if (rule.pattern) rules.push('pattern');
        return `<tr><td><code>${escapeHtml(field)}</code></td><td>${escapeHtml(
          rule.type || 'any'
        )}</td><td>${escapeHtml(rules.join(', ') || '—')}</td></tr>`;
      })
      .join('') +
    '</table>'
  );
}

function methodColor(m) {
  return (
    {
      GET: '#36b37e',
      POST: '#ffab00',
      PUT: '#4c9aff',
      DELETE: '#ff5630',
      PATCH: '#6554c0',
    }[m] || '#8993a4'
  );
}

function renderHtml(router) {
  const routes = collectRoutes(router);
  const cards = routes
    .map(
      (r) => `
      <article class="route">
        <header>
          <span class="badge" style="background:${methodColor(r.method)}">${r.method}</span>
          <code class="path">${escapeHtml(r.path)}</code>
        </header>
        ${r.description ? `<p class="desc">${escapeHtml(r.description)}</p>` : ''}
        ${
          r.params.length
            ? `<p class="muted">path params: ${r.params
                .map((p) => `<code>:${escapeHtml(p)}</code>`)
                .join(' ')}</p>`
            : ''
        }
        <div class="body-spec">${schemaRows(r.bodySchema)}</div>
      </article>`
    )
    .join('');

  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8">
<title>Forge — API Reference</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  :root { color-scheme: dark; }
  body { margin:0; font-family:-apple-system,Segoe UI,Roboto,sans-serif;
    background:#0d1117; color:#e6edf3; }
  header.top { padding:2rem 2rem 1rem; border-bottom:1px solid #21262d; }
  header.top h1 { margin:0; font-size:1.6rem; }
  header.top p { color:#8b949e; margin:.4rem 0 0; }
  .wrap { max-width:880px; margin:0 auto; padding:1.5rem 2rem 4rem; }
  .route { background:#161b22; border:1px solid #21262d; border-radius:10px;
    padding:1rem 1.25rem; margin:1rem 0; }
  .route header { display:flex; align-items:center; gap:.75rem; }
  .badge { color:#0d1117; font-weight:700; font-size:.75rem;
    padding:.25rem .55rem; border-radius:5px; letter-spacing:.04em; }
  .path { font-size:1.05rem; }
  code { background:#21262d; padding:.1rem .4rem; border-radius:4px;
    font-family:ui-monospace,SFMono-Regular,Menlo,monospace; }
  .desc { color:#c9d1d9; margin:.6rem 0 .2rem; }
  .muted { color:#8b949e; font-size:.9rem; }
  table.schema { border-collapse:collapse; margin-top:.6rem; width:100%; }
  table.schema th, table.schema td { text-align:left; padding:.35rem .6rem;
    border-bottom:1px solid #21262d; font-size:.88rem; }
  table.schema th { color:#8b949e; font-weight:600; }
  a { color:#4c9aff; }
</style></head>
<body>
  <header class="top">
    <h1>⚒ Forge — API Reference</h1>
    <p>Auto-generated from registered routes. <a href="/_routes?format=json">JSON</a></p>
  </header>
  <div class="wrap">
    ${cards || '<p class="muted">No routes registered.</p>'}
  </div>
</body></html>`;
}

module.exports = { renderHtml, renderJson };
