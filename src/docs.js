'use strict';

// Renders the live API documentation served at /_routes — loom-styled.
// Schemas live with the handlers, so this view cannot drift from code.

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
  return { service: 'loom', routes: collectRoutes(router) };
}

function esc(s) {
  return String(s).replace(/[&<>"]/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])
  );
}

// ─── tiny syntax highlighters ──────────────────────────────────────────
function hiCurl(src) {
  return src.split('\n').map((line) => {
    if (line.trimStart().startsWith('#')) {
      return '<span class="tk cmnt">' + esc(line) + '</span>';
    }
    const toks = line.match(/('[^']*'|"[^"]*"|\s+|\S+)/g) || [];
    return toks.map((t) => {
      if (/^\s+$/.test(t))         return esc(t);
      if (/^['"]/.test(t))         return '<span class="tk str">' + esc(t) + '</span>';
      if (t === 'curl')            return '<span class="tk cmd">' + esc(t) + '</span>';
      if (/^-[A-Za-z]/.test(t))    return '<span class="tk flag">' + esc(t) + '</span>';
      if (t === '\\')              return '<span class="tk cont">\\</span>';
      if (/^https?:|^:\d+|^\/[A-Za-z]/.test(t))
                                   return '<span class="tk url">' + esc(t) + '</span>';
      return esc(t);
    }).join('');
  }).join('\n');
}

function hiResp(src) {
  let out = '', i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === '\n')               { out += '\n'; i++; continue; }
    if (/[ \t]/.test(c))          { out += esc(c); i++; continue; }
    if (c === '"') {
      let j = i + 1;
      while (j < src.length && src[j] !== '"') { if (src[j] === '\\') j++; j++; }
      const str = src.slice(i, j + 1);
      let k = j + 1;
      while (k < src.length && /[ \t]/.test(src[k])) k++;
      const type = src[k] === ':' ? 'key' : 'str';
      out += '<span class="tk ' + type + '">' + esc(str) + '</span>';
      i = j + 1;
      continue;
    }
    if (/[0-9]/.test(c) || (c === '-' && /[0-9]/.test(src[i + 1] || ''))) {
      let j = i;
      if (c === '-') j++;
      while (j < src.length && /[0-9.]/.test(src[j])) j++;
      const num = src.slice(i, j);
      const cls = /^[2345]\d\d$/.test(num) ? 'status s' + num[0] : 'num';
      out += '<span class="tk ' + cls + '">' + esc(num) + '</span>';
      i = j;
      continue;
    }
    if (/[A-Za-z/]/.test(c)) {
      let j = i;
      while (j < src.length && /[A-Za-z0-9/.]/.test(src[j])) j++;
      const word = src.slice(i, j);
      let cls = 'ident';
      if (/^HTTP\//.test(word)) cls = 'http';
      else if (word === 'true' || word === 'false' || word === 'null') cls = 'kw';
      out += '<span class="tk ' + cls + '">' + esc(word) + '</span>';
      i = j;
      continue;
    }
    out += '<span class="tk punct">' + esc(c) + '</span>';
    i++;
  }
  return out;
}

// ─── per-route example builders (mirrors the demo) ─────────────────────
function exampleBody(bodySchema) {
  const example = {};
  for (const [k, v] of Object.entries(bodySchema)) {
    if (v.type === 'string') {
      if (k === 'email') example[k] = 'a@b.co';
      else if (v.enum) example[k] = v.enum[0];
      else example[k] = (v.min || 0) >= 2 ? 'sample' : 'x';
    } else if (v.type === 'number') example[k] = v.min || 1;
    else if (v.type === 'boolean') example[k] = true;
  }
  return example;
}

function curlFor(r) {
  const url = ':3000' + r.path.replace(/:(\w+)/g, (_, k) =>
    ({ id: '42' }[k] || ('{' + k + '}')));
  if (r.method === 'GET') return 'curl ' + url;
  if (r.method === 'DELETE') return 'curl -X DELETE ' + url;

  // POST / PUT / PATCH — send a JSON body.
  const body = r.bodySchema
    ? exampleBody(r.bodySchema)
    : (r.method === 'PATCH' ? { name: 'new name' } : {});
  return 'curl -X ' + r.method + ' ' + url + " \\\n" +
         "  -H 'Content-Type: application/json' \\\n" +
         "  -d '" + JSON.stringify(body) + "'";
}

function respFor(r) {
  if (r.method === 'POST' && r.bodySchema) {
    return 'HTTP/1.1 201 Created\n{ "created": true, "user": { "id": 2, … } }';
  }
  if (r.method === 'PUT')    return '{ "updated": true, "user": { "id": 42, … } }';
  if (r.method === 'PATCH')  return '{ "patched": true, "user": { "id": 42, … } }';
  if (r.method === 'DELETE') return '{ "deleted": true, "user": { "id": 42, … } }';
  if (/users\/:id$/.test(r.path)) {
    return '{ "id": 42, "name": "Alice", "email": "alice@example.com" }';
  }
  if (r.path === '/api/hello') return '{ "message": "Hello, World!", "from": "loom" }';
  if (r.path === '/api/users') return '[ { "id": 1, "name": "Alice", "email": "alice@example.com" } ]';
  if (r.path === '/api/echo')  return 'HTTP/1.1 201 Created\n{ "echoed": true }';
  return '';
}

// Any validated write route (typed app.route with a body schema) can return a
// structured 400, so show the failure shape for all of them — not just POST.
function failFor(r) {
  if (!r.bodySchema) return '';
  return 'HTTP/1.1 400 Bad Request\n' +
         '{ "error": "Validation failed",\n' +
         '  "details": [{ "field": "email", "message": "pattern" }] }';
}

// ─── schema row builder ────────────────────────────────────────────────
function schemaRows(schema) {
  if (!schema) return '';
  return Object.entries(schema).map(([field, rule]) => {
    const rules = [];
    if (rule.required) rules.push('<span class="req">required</span>');
    if (rule.min !== undefined) rules.push('min ' + rule.min);
    if (rule.max !== undefined) rules.push('max ' + rule.max);
    if (rule.enum) rules.push('enum [' + rule.enum.join(', ') + ']');
    if (rule.pattern) rules.push('pattern');
    return '<div class="row">' +
      '<code>' + esc(field) + '</code>' +
      '<span class="type">' + esc(rule.type || 'any') + '</span>' +
      '<span class="rules">' + (rules.join(' · ') || '—') + '</span>' +
    '</div>';
  }).join('');
}

// ─── path with highlighted :params ─────────────────────────────────────
function highlightPath(p) {
  return esc(p).replace(/(:[a-z]+)/gi, '<span class="param">$1</span>');
}

// ─── route card ────────────────────────────────────────────────────────
function renderRoute(r) {
  const method = r.method;
  const curl = curlFor(r);
  const resp = respFor(r);
  const fail = failFor(r);

  const lh = [
    r.description ? '<p class="d">' + esc(r.description) + '</p>' : '',
    r.bodySchema
      ? '<div class="schema">' +
        '<div class="h"><span>field</span><span>type</span><span>rules</span></div>' +
        schemaRows(r.bodySchema) +
        '</div>'
      : (r.params.length
        ? '<div class="schema">' +
          '<div class="h"><span>param</span><span>type</span><span>note</span></div>' +
          r.params.map((p) =>
            '<div class="row"><code>:' + esc(p) + '</code><span class="type">string</span><span class="rules">path segment</span></div>'
          ).join('') +
          '</div>'
        : ''),
  ].join('');

  const rh = (curl || resp) ? [
    curl ? (
      '<div class="codeblock">' +
        '<div class="lbl"><span>request</span>' +
          '<button type="button" class="copy-btn" data-copy="' + esc(curl) + '">copy</button>' +
        '</div>' +
        '<pre>' + hiCurl(curl) + '</pre>' +
      '</div>'
    ) : '',
    resp ? (
      '<div class="codeblock">' +
        '<div class="lbl"><span>response</span><b>200 / 201 ok</b></div>' +
        '<pre>' + hiResp(resp) + '</pre>' +
      '</div>'
    ) : '',
    fail ? (
      '<div class="codeblock">' +
        '<div class="lbl"><span>validation fail</span><b class="amber">400</b></div>' +
        '<pre>' + hiResp(fail) + '</pre>' +
      '</div>'
    ) : '',
  ].join('') : '';

  return (
    '<div class="lm-route">' +
      '<div class="lm-route-head">' +
        '<span class="m ' + method + '">' + method + '</span>' +
        '<span class="p">' + highlightPath(r.path) + '</span>' +
        // "try it" opens the endpoint in the browser — only meaningful for GET
        // (a plain link can't issue POST/PUT/etc.), so we omit it otherwise.
        (method === 'GET'
          ? '<a class="try" href="' + esc(r.path.replace(/:\w+/g, '42')) + '" target="_blank" rel="noopener">try it ↗</a>'
          : '') +
      '</div>' +
      '<div class="lm-route-body' + (rh ? '' : ' single') + '">' +
        '<div class="lh">' + (lh || '<p class="d" style="color:var(--muted)">no documentation</p>') + '</div>' +
        (rh ? '<div class="rh">' + rh + '</div>' : '') +
      '</div>' +
    '</div>'
  );
}

// ─── full page ─────────────────────────────────────────────────────────
function renderHtml(router) {
  const routes = collectRoutes(router);
  const counts = routes.reduce((acc, r) => { acc[r.method] = (acc[r.method] || 0) + 1; return acc; }, {});
  const total = routes.length;
  const cards = routes.length
    ? routes.map(renderRoute).join('')
    : '<div class="lm-empty">no routes registered.</div>';

  return `<!DOCTYPE html>
<html lang="en" data-theme="dark">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>loom — api reference</title>
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
    <a href="/_routes" class="on"><span class="kbd">[r]</span>routes</a>
    <a href="/_trace"><span class="kbd">[t]</span>trace</a>
  </nav>
  <div class="meta">
    <span>:3000</span>
    <span><b>${total}</b> routes</span>
    <button class="lm-theme-btn" type="button">☀ light</button>
  </div>
</header>

<main class="lm-stage">

  <div class="lm-routes-head">
    <div>
      <h2>api reference</h2>
      <p class="sub">
        Auto-generated from <b>app.route()</b> metadata — schemas live with the handler, so docs can never drift from code. Invalid bodies short-circuit with a structured <b>400</b> before the handler runs.
      </p>
    </div>
    <a class="json" href="/_routes?format=json">json</a>
  </div>

  <div class="lm-routes-tabs">
    <span class="on">all<b>${total}</b></span>
    ${['GET', 'POST', 'PUT', 'DELETE', 'PATCH'].filter(m => counts[m]).map(m =>
      `<span>${m.toLowerCase()}<b>${counts[m]}</b></span>`).join('')}
    <input id="route-search" class="ml-auto route-search" type="text" placeholder="filter routes…" autocomplete="off">
  </div>

  ${cards}

</main>

<footer class="lm-foot">
  <span class="badge">loom 0.1</span>
  <span><span class="muted">cwd</span> <span style="color:var(--ink)">/_routes</span></span>
  <span><span class="muted">routes</span> <b style="color:var(--ink)">${total}</b></span>
  <span><span class="muted">typed</span> <b style="color:var(--ink)">${routes.filter(r => r.bodySchema).length}</b></span>
  <span><span class="muted">clock</span> <span class="clock">--:--:--</span></span>
  <span class="spacer"></span>
  <span class="kbd-hints">nav <b>g</b> <b>c</b> <b>p</b> <b>r</b> <b>t</b> · theme <b>⇧t</b></span>
</footer>

<script src="./loom-shared.js"></script>
<script>
// Filter routes by method tab + free-text search (client-side, no network).
const tabs = Array.from(document.querySelectorAll('.lm-routes-tabs span'));
const routes = Array.from(document.querySelectorAll('.lm-route'));
const search = document.getElementById('route-search');
let activeMethod = 'all';

function applyFilters() {
  const q = (search.value || '').trim().toLowerCase();
  routes.forEach((r) => {
    const m = ((r.querySelector('.m') || {}).textContent || '').toLowerCase();
    const path = ((r.querySelector('.p') || {}).textContent || '').toLowerCase();
    const okMethod = activeMethod === 'all' || m === activeMethod;
    const okText = !q || path.includes(q) || m.includes(q);
    r.style.display = (okMethod && okText) ? '' : 'none';
  });
}

tabs.forEach((t) => {
  t.addEventListener('click', () => {
    tabs.forEach((x) => x.classList.remove('on'));
    t.classList.add('on');
    activeMethod = (t.textContent || '').replace(/[0-9]/g, '').trim();
    applyFilters();
  });
});
search.addEventListener('input', applyFilters);

// "copy" buttons — copy the curl command to the clipboard.
document.querySelectorAll('.copy-btn').forEach((b) => {
  b.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(b.dataset.copy || '');
      const prev = b.textContent;
      b.textContent = 'copied ✓';
      setTimeout(() => { b.textContent = prev; }, 1200);
    } catch (_) {
      b.textContent = 'copy failed';
    }
  });
});
</script>
</body>
</html>`;
}

module.exports = { renderHtml, renderJson };
