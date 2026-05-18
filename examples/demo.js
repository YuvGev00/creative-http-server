'use strict';

const path = require('path');
const forge = require('../src/server');

const app = forge();

// --- Middleware: simple request logger ---
app.use((req, res, next) => {
  console.log(`${new Date().toISOString()}  ${req.method} ${req.path}`);
  next();
});

// --- Required feature 1: route handlers (GET / POST / params) ---
app.get('/api/hello', (req, res) => {
  res.json({ message: 'Hello, World!', from: 'Forge' });
});

app.get('/api/users/:id', (req, res) => {
  res.json({ id: req.params.id, name: `User ${req.params.id}` });
});

// In-memory demo store.
const users = [{ id: 1, name: 'Alice', email: 'alice@example.com' }];

app.get('/api/users', (req, res) => {
  res.json(users);
});

// --- Creative feature: declarative typed route with body validation ---
app.route({
  method: 'POST',
  path: '/api/users',
  description: 'Create a user. Body is validated automatically.',
  body: {
    name: { type: 'string', required: true, min: 2, max: 40 },
    email: {
      type: 'string',
      required: true,
      pattern: /^[^@\s]+@[^@\s]+\.[^@\s]+$/,
    },
    role: { type: 'string', enum: ['admin', 'member'] },
  },
  handler: (req, res) => {
    const user = {
      id: users.length + 1,
      name: req.body.name,
      email: req.body.email,
      role: req.body.role || 'member',
    };
    users.push(user);
    res.status(201).json({ created: true, user });
  },
});

// --- Creative feature: hand-rolled WebSocket chat (broadcast) ---
const chatClients = new Set();
app.ws('/chat', (conn) => {
  chatClients.add(conn);
  conn.send(JSON.stringify({ system: `welcome — ${chatClients.size} online` }));
  conn.on('message', (msg) => {
    for (const c of chatClients) c.send(JSON.stringify({ msg }));
  });
  conn.on('close', () => chatClients.delete(conn));
});

// --- Creative feature: Streaming Lab ---

// Chunked Transfer Theater: the page assembles itself live, one
// hand-built HTTP/1.1 chunk at a time.
app.get('/demo/chunked', (req, res) => {
  const stream = res.chunked('text/html; charset=utf-8');
  stream.write(
    '<!doctype html><meta charset="utf-8">' +
      '<body style="font-family:ui-monospace,Menlo,monospace;background:#0d1117;color:#e6edf3;padding:2rem;line-height:1.8">' +
      '<h2>⚒ Chunked Transfer Theater</h2>' +
      '<p>Each line below is a separate HTTP chunk, written by the raw ' +
      '<code>net</code> server with a delay. Watch it build:</p>'
  );
  let n = 0;
  const timer = setInterval(() => {
    n++;
    stream.write(
      `<div>chunk #${n} · ${new Date().toISOString()} · ` +
        'sent without buffering the whole page</div>'
    );
    if (n >= 8) {
      clearInterval(timer);
      stream.end('<p style="color:#36b37e">✓ stream complete (0-length chunk sent)</p></body>');
    }
  }, 450);
});

// Server-Sent Events: a one-way live feed over plain HTTP (no WebSocket).
app.get('/demo/sse', (req, res) => {
  const channel = res.sse();
  let i = 0;
  channel.send({ hello: 'SSE stream open', at: new Date().toISOString() }, 'open');
  const timer = setInterval(() => {
    if (channel.closed) return clearInterval(timer);
    i++;
    channel.send({ tick: i, time: new Date().toISOString() }, 'tick');
    if (i >= 1000) clearInterval(timer); // safety bound
  }, 1000);
});

// --- Required feature 2: static file serving ---
app.static(path.join(__dirname, 'public'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\n  ⚒  Forge demo running on http://localhost:${PORT}`);
  console.log(`     API docs:       http://localhost:${PORT}/_routes`);
  console.log(`     Flight recorder: http://localhost:${PORT}/_trace`);
  console.log(`     WebSocket chat:  http://localhost:${PORT}/chat.html`);
  console.log(`     Streaming Lab:   http://localhost:${PORT}/streaming-lab.html\n`);
});
