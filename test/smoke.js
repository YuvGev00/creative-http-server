'use strict';

// Self-contained smoke test. Boots a Forge app on an ephemeral port and
// drives it with a raw `net` client (no http module). Exits non-zero on
// the first failed assertion.

const net = require('net');
const path = require('path');
const forge = require('../src/server');

let passed = 0;
let failed = 0;

function ok(name, cond, extra) {
  if (cond) {
    passed++;
    console.log(`  ✓ ${name}`);
  } else {
    failed++;
    console.log(`  ✗ ${name}${extra ? '  -> ' + extra : ''}`);
  }
}

// Send a raw request string (optionally in chunks) and collect the response.
function rawRequest(port, chunks, { delayMs = 0 } = {}) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1');
    let data = Buffer.alloc(0);
    socket.on('connect', async () => {
      for (let i = 0; i < chunks.length; i++) {
        socket.write(chunks[i]);
        if (delayMs && i < chunks.length - 1) {
          await new Promise((r) => setTimeout(r, delayMs));
        }
      }
    });
    socket.on('data', (d) => {
      data = Buffer.concat([data, d]);
    });
    socket.on('end', () => resolve(parseResponse(data)));
    socket.on('error', reject);
  });
}

function parseResponse(buf) {
  const text = buf.toString('latin1');
  const idx = text.indexOf('\r\n\r\n');
  const head = text.slice(0, idx);
  const lines = head.split('\r\n');
  const status = parseInt(lines[0].split(' ')[1], 10);
  const headers = {};
  for (let i = 1; i < lines.length; i++) {
    const c = lines[i].indexOf(':');
    headers[lines[i].slice(0, c).toLowerCase().trim()] = lines[i]
      .slice(c + 1)
      .trim();
  }
  return { status, headers, body: buf.slice(idx + 4) };
}

function get(p) {
  return `GET ${p} HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n`;
}
function post(p, body) {
  return (
    `POST ${p} HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\n` +
    `Content-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`
  );
}

async function main() {
  const app = forge();
  app.get('/api/hello', (req, res) => res.json({ message: 'hi' }));
  app.get('/api/users/:id', (req, res) => res.json({ id: req.params.id }));
  app.route({
    method: 'POST',
    path: '/api/users',
    body: {
      name: { type: 'string', required: true, min: 2 },
      email: { type: 'string', required: true, pattern: /^[^@]+@[^@]+$/ },
    },
    handler: (req, res) => res.status(201).json({ ok: true, name: req.body.name }),
  });
  app.static(path.join(__dirname, '..', 'examples', 'public'));

  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const port = server.address().port;

  // 1. JSON route
  let r = await rawRequest(port, [get('/api/hello')]);
  ok('GET /api/hello -> 200 JSON', r.status === 200 && JSON.parse(r.body).message === 'hi');

  // 2. Path params
  r = await rawRequest(port, [get('/api/users/42')]);
  ok('GET /api/users/:id captures param', r.status === 200 && JSON.parse(r.body).id === '42');

  // 3. Valid POST passes validation
  r = await rawRequest(port, [post('/api/users', '{"name":"Al","email":"a@b.c"}')]);
  ok('POST valid body -> 201', r.status === 201, `got ${r.status}`);

  // 4. Invalid POST rejected by validator (creative feature)
  r = await rawRequest(port, [post('/api/users', '{"name":"A"}')]);
  const errBody = JSON.parse(r.body);
  ok(
    'POST invalid body -> 400 with details',
    r.status === 400 && Array.isArray(errBody.details) && errBody.details.length >= 1,
    `got ${r.status}`
  );

  // 5. Static file with correct MIME
  r = await rawRequest(port, [get('/style.css')]);
  ok(
    'GET /style.css -> 200 text/css',
    r.status === 200 && r.headers['content-type'].includes('text/css')
  );

  // 6. Directory traversal blocked
  r = await rawRequest(port, [get('/../../../../etc/passwd')]);
  ok('traversal blocked (403/404, no leak)', r.status === 403 || r.status === 404, `got ${r.status}`);

  // 7. Live docs page (creative feature)
  r = await rawRequest(port, [get('/_routes')]);
  ok(
    'GET /_routes -> 200 HTML docs',
    r.status === 200 && r.body.toString().includes('Forge')
  );
  r = await rawRequest(port, [get('/_routes?format=json')]);
  ok('GET /_routes?format=json -> route list', r.status === 200 && Array.isArray(JSON.parse(r.body).routes));

  // 8. Split request across two TCP writes (proves buffering fix)
  const full = post('/api/users', '{"name":"Split","email":"s@p.c"}');
  const splitAt = full.indexOf('\r\n\r\n') + 2; // mid-headers
  r = await rawRequest(port, [full.slice(0, splitAt), full.slice(splitAt)], { delayMs: 40 });
  ok('split request reassembled -> 201', r.status === 201, `got ${r.status}`);

  // 9. 404 for unknown route
  r = await rawRequest(port, [get('/nope')]);
  ok('unknown route -> 404', r.status === 404);

  server.close();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
