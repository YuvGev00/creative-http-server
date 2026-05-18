'use strict';

// Self-contained smoke test. Boots a Forge app on an ephemeral port and
// drives it with a raw `net` client (no http module). Exits non-zero on
// the first failed assertion.

const net = require('net');
const crypto = require('crypto');
const path = require('path');
const forge = require('../src/server');
const wsproto = require('../src/websocket');

// Build a masked client TEXT frame (clients MUST mask, per RFC 6455).
function maskedTextFrame(str) {
  const data = Buffer.from(str, 'utf8');
  const mask = crypto.randomBytes(4);
  const header = Buffer.from([0x81, 0x80 | data.length]);
  const masked = Buffer.allocUnsafe(data.length);
  for (let i = 0; i < data.length; i++) masked[i] = data[i] ^ mask[i & 3];
  return Buffer.concat([header, mask, masked]);
}

// Open a WS connection, send one message, resolve with the echoed text.
function wsRoundTrip(port, pathname, message) {
  return new Promise((resolve, reject) => {
    const key = crypto.randomBytes(16).toString('base64');
    const sock = net.connect(port, '127.0.0.1');
    let phase = 'handshake';
    let buf = Buffer.alloc(0);
    sock.on('connect', () => {
      sock.write(
        `GET ${pathname} HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\n` +
          `Connection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\n` +
          `Sec-WebSocket-Version: 13\r\n\r\n`
      );
    });
    sock.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      if (phase === 'handshake') {
        const i = buf.indexOf('\r\n\r\n');
        if (i === -1) return;
        const head = buf.slice(0, i).toString();
        const expect = wsproto.acceptKey(key);
        if (!head.includes('101') || !head.includes(expect)) {
          return reject(new Error('bad handshake: ' + head));
        }
        buf = buf.slice(i + 4);
        phase = 'frames';
        sock.write(maskedTextFrame(message));
      }
      if (phase === 'frames') {
        const { frames } = wsproto.decodeFrames(buf);
        if (frames.length) {
          sock.end();
          resolve(frames[0].payload.toString('utf8'));
        }
      }
    });
    sock.on('error', reject);
    setTimeout(() => reject(new Error('ws timeout')), 2000);
  });
}

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
  return { status, headers, rawHead: head, body: buf.slice(idx + 4) };
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
function head(p) {
  return `HEAD ${p} HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n`;
}
// Raw POST where we control the exact Content-Length header text.
function postRaw(p, clHeaderValue, body) {
  return (
    `POST ${p} HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\n` +
    `Content-Length: ${clHeaderValue}\r\nConnection: close\r\n\r\n${body}`
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
  app.get('/files/*', (req, res) =>
    res.json({ wildcard: req.params.wildcard })
  );
  app.get('/send-object', (req, res) => res.send({ via: 'send' }));
  app.ws('/ws-echo', (conn) => {
    conn.on('message', (m) => conn.send('echo:' + m));
  });
  let mwRuns = 0;
  app.use('/double', (req, res, next) => {
    next();
    next(); // second call must be ignored
  });
  app.get('/double', (req, res) => {
    mwRuns++;
    res.json({ runs: mwRuns });
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

  // --- Regression tests for issues found in the Codex review ---

  // 10. Malformed Content-Length ("5junk") must be rejected, not accepted.
  r = await rawRequest(port, [postRaw('/api/users', '5junk', 'hello')]);
  ok('bad Content-Length "5junk" -> 400', r.status === 400, `got ${r.status}`);

  // 11. Conflicting duplicate Content-Length must be rejected (smuggling).
  const dup =
    'POST /api/users HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\n' +
    'Content-Length: 5\r\nContent-Length: 6\r\nConnection: close\r\n\r\nhello!';
  r = await rawRequest(port, [dup]);
  ok('conflicting Content-Length -> 400', r.status === 400, `got ${r.status}`);

  // 12. Transfer-Encoding: chunked must be rejected, not mis-framed.
  const chunked =
    'POST /api/users HTTP/1.1\r\nHost: x\r\nTransfer-Encoding: chunked\r\n' +
    'Connection: close\r\n\r\n0\r\n\r\n';
  r = await rawRequest(port, [chunked]);
  ok('chunked request -> 400', r.status === 400, `got ${r.status}`);

  // 13. Wildcard route now actually matches (was silently broken).
  r = await rawRequest(port, [get('/files/a/b.txt')]);
  ok(
    'wildcard /files/* matches nested path',
    r.status === 200 && JSON.parse(r.body).wildcard === 'a/b.txt',
    `got ${r.status} ${r.body}`
  );

  // 14. HEAD returns headers (incl. Content-Length) but NO body.
  r = await rawRequest(port, [head('/style.css')]);
  ok(
    'HEAD /style.css -> 200, Content-Length set, empty body',
    r.status === 200 &&
      r.headers['content-length'] &&
      Number(r.headers['content-length']) > 0 &&
      r.body.length === 0,
    `status ${r.status} bodylen ${r.body.length}`
  );

  // 15. CR/LF in a header value is rejected (response-splitting guard).
  app.get('/inject', (req, res) => {
    try {
      res.set('X-Evil', 'a\r\nX-Injected: yes');
      res.json({ injected: false });
    } catch {
      res.status(500).json({ blocked: true });
    }
  });
  r = await rawRequest(port, [get('/inject')]);
  ok(
    'CRLF header injection blocked',
    !r.headers['x-injected'] && r.status === 500,
    `injected header present? ${!!r.headers['x-injected']}`
  );

  // --- Regression tests for the second (skeptical) review ---

  // 16. res.send() with an object must not hang — it should return JSON.
  r = await rawRequest(port, [get('/send-object')]);
  ok(
    'res.send(object) -> 200 JSON (no hang)',
    r.status === 200 && JSON.parse(r.body).via === 'send',
    `got ${r.status} ${r.body}`
  );

  // 17. Calling next() twice must run the route exactly once.
  r = await rawRequest(port, [get('/double')]);
  ok(
    'double next() runs route once',
    r.status === 200 && JSON.parse(r.body).runs === 1,
    `runs=${r.body}`
  );

  // 18. %00 null byte in a static path -> 400, not 500.
  r = await rawRequest(port, [get('/%00.txt')]);
  ok('null byte in path -> 400', r.status === 400, `got ${r.status}`);

  // 19. Oversized declared Content-Length rejected before buffering -> 413.
  const huge =
    'POST /api/users HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\n' +
    'Content-Length: 999999999\r\nConnection: close\r\n\r\n';
  r = await rawRequest(port, [huge]);
  ok('oversized Content-Length -> 413', r.status === 413, `got ${r.status}`);

  // --- Regression tests for the final (holistic) review ---

  // 20. res.status() with an injected string must not split the response.
  app.get('/badstatus', (req, res) => {
    try {
      res.status('200\r\nX-Injected: yes').send('hi');
    } catch {
      res.status(500).json({ blocked: true });
    }
  });
  r = await rawRequest(port, [get('/badstatus')]);
  ok(
    'status() injection blocked',
    !r.headers['x-injected'] && r.status === 500,
    `injected? ${!!r.headers['x-injected']} status ${r.status}`
  );

  // 21. set('content-length') must not produce a duplicate Content-Length.
  app.get('/dupcl', (req, res) => {
    res.set('content-length', '999').send('ok');
  });
  r = await rawRequest(port, [get('/dupcl')]);
  const clCount = r.rawHead
    ? (r.rawHead.match(/content-length/gi) || []).length
    : (Object.keys(r.headers).filter((k) => k === 'content-length').length);
  ok(
    'no duplicate Content-Length header',
    clCount === 1,
    `content-length appeared ${clCount}x`
  );

  // --- Creative feature: Flight Recorder ---

  // 22. /_trace?format=json records prior requests with timing + status.
  r = await rawRequest(port, [get('/_trace?format=json')]);
  const trace = JSON.parse(r.body);
  const helloTrace = trace.recent.find((e) => e.path === '/api/hello');
  ok(
    '/_trace records request lifecycle',
    r.status === 200 &&
      Array.isArray(trace.recent) &&
      helloTrace &&
      typeof helloTrace.totalMs === 'number' &&
      helloTrace.status === 200,
    `recent=${trace.recent ? trace.recent.length : 'n/a'}`
  );

  // 23. /_trace HTML renders.
  r = await rawRequest(port, [get('/_trace')]);
  ok(
    '/_trace HTML view renders',
    r.status === 200 && r.body.toString().includes('Flight Recorder'),
    `got ${r.status}`
  );

  // --- Creative feature: hand-rolled WebSocket ---

  // 24. Full RFC 6455 handshake + masked frame round-trips through app.ws().
  try {
    const echoed = await wsRoundTrip(port, '/ws-echo', 'hello ws');
    ok(
      'WebSocket handshake + masked frame echo',
      echoed === 'echo:hello ws',
      `got "${echoed}"`
    );
  } catch (e) {
    ok('WebSocket handshake + masked frame echo', false, e.message);
  }

  // 25. acceptKey matches the RFC 6455 published example vector.
  ok(
    'WebSocket accept key matches RFC 6455 vector',
    wsproto.acceptKey('dGhlIHNhbXBsZSBub25jZQ==') ===
      's3pPLMBiTxaQ9kYGzzhZRbK+xOo=',
    'accept key mismatch'
  );

  // --- Creative feature: Draw & Guess game logic ---
  {
    const { DrawGame } = require('../src/draw-game');
    const g = new DrawGame();
    const events = [];
    g.onBroadcast((e) => events.push(e));

    g.addPlayer('a', 'Alice');
    g.addPlayer('b', 'Bob'); // 2 players -> a round auto-starts
    const drawer = g.drawerId;
    const guesser = drawer === 'a' ? 'b' : 'a';

    ok(
      'game: round starts with a word + a drawer at 2 players',
      g.roundActive === true &&
        typeof g.word === 'string' &&
        g.word.length > 0 &&
        (drawer === 'a' || drawer === 'b'),
      `drawer=${drawer} word=${g.word}`
    );

    // Wrong guess: no score, shown as chat.
    const before = g.players.get(guesser).score;
    g.guess(guesser, 'definitely-not-the-word');
    ok(
      'game: wrong guess scores nothing',
      g.players.get(guesser).score === before,
      `score=${g.players.get(guesser).score}`
    );

    // Correct guess: guesser scores, drawer gets points, round ends.
    g.guess(guesser, g.word);
    const guesserScore = g.players.get(guesser).score;
    const drawerScore = g.players.get(drawer).score;
    ok(
      'game: correct guess scores guesser + drawer and ends round',
      guesserScore > 0 && drawerScore === 50 && g.roundActive === false,
      `guesser=${guesserScore} drawer=${drawerScore} active=${g.roundActive}`
    );

    // Drawer's word is hidden from the guesser in per-player state.
    g.startRound();
    const sDrawer = g.stateFor(g.drawerId);
    const sOther = g.stateFor(g.drawerId === 'a' ? 'b' : 'a');
    ok(
      'game: only the drawer is told the word',
      typeof sDrawer.word === 'string' && sOther.word === null,
      `drawer.word=${sDrawer.word} other.word=${sOther.word}`
    );
  }

  server.close();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
