'use strict';

const path = require('path');
const forge = require('../src/server');

const app = forge();

app.use((req, res, next) => {
  console.log(`${new Date().toISOString()}  ${req.method} ${req.path}`);
  next();
});

app.get('/api/hello', (req, res) => {
  res.json({ message: 'Hello, World!', from: 'Forge' });
});

app.post('/api/echo', (req, res) => {
  res.status(201).json(req.body);
});

const users = [{ id: 1, name: 'Alice', email: 'alice@example.com', role: 'admin' }];
let nextUserId = 2;

const findUser = (id) => users.find((u) => String(u.id) === String(id));

const userBody = {
  name: { type: 'string', required: true, min: 2, max: 40 },
  email: { type: 'string', required: true, pattern: /^[^@\s]+@[^@\s]+\.[^@\s]+$/ },
  role: { type: 'string', enum: ['admin', 'member'] },
};

app.get('/api/users', (req, res) => {
  res.json(users);
});

app.get('/api/users/:id', (req, res) => {
  const user = findUser(req.params.id);
  if (!user) return res.status(404).json({ error: 'User not found', id: req.params.id });
  res.json(user);
});

app.route({
  method: 'POST',
  path: '/api/users',
  description: 'Create a user. Body is validated automatically.',
  body: userBody,
  handler: (req, res) => {
    const user = {
      id: nextUserId++,
      name: req.body.name,
      email: req.body.email,
      role: req.body.role || 'member',
    };
    users.push(user);
    res.status(201).json({ created: true, user });
  },
});

app.route({
  method: 'PUT',
  path: '/api/users/:id',
  description: 'Replace a user wholesale. Same validation as create.',
  body: userBody,
  handler: (req, res) => {
    const user = findUser(req.params.id);
    if (!user) return res.status(404).json({ error: 'User not found', id: req.params.id });
    user.name = req.body.name;
    user.email = req.body.email;
    user.role = req.body.role || 'member';
    res.json({ updated: true, user });
  },
});

app.patch('/api/users/:id', (req, res) => {
  const user = findUser(req.params.id);
  if (!user) return res.status(404).json({ error: 'User not found', id: req.params.id });
  const body = req.body || {};
  if (body.name !== undefined) user.name = body.name;
  if (body.email !== undefined) user.email = body.email;
  if (body.role !== undefined) user.role = body.role;
  res.json({ patched: true, user });
});

app.delete('/api/users/:id', (req, res) => {
  const i = users.findIndex((u) => String(u.id) === String(req.params.id));
  if (i === -1) return res.status(404).json({ error: 'User not found', id: req.params.id });
  const [removed] = users.splice(i, 1);
  res.json({ deleted: true, user: removed });
});

const chatClients = new Set();
app.ws('/chat', (conn) => {
  chatClients.add(conn);
  conn.send(JSON.stringify({ system: `welcome — ${chatClients.size} online` }));
  conn.on('message', (msg) => {
    for (const c of chatClients) c.send(JSON.stringify({ msg }));
  });
  conn.on('close', () => chatClients.delete(conn));
});

const { DrawGame } = require('../src/draw-game');
const game = new DrawGame();
const gameConns = new Map();
let nextId = 1;

game.onBroadcast((event) => {
  const { _to, ...payload } = event;
  const msg = JSON.stringify(payload);
  if (_to) {
    const c = gameConns.get(_to);
    if (c) c.send(msg);
  } else {
    for (const c of gameConns.values()) c.send(msg);
  }
});
setInterval(() => game.tick(), 1000);

app.ws('/game', (conn) => {
  const id = 'p' + nextId++;
  gameConns.set(id, conn);
  let joined = false;

  conn.on('message', (raw) => {
    let m;
    try { m = JSON.parse(raw); } catch { return; }

    if (m.type === 'join') {
      if (joined) return;
      joined = true;
      game.addPlayer(id, m.name);
    } else if (!joined) {
      return;
    } else if (m.type === 'op') {

      game.canvasOp(id, m.op);
    } else if (m.type === 'guess') {
      game.guess(id, m.text);
    }
  });

  conn.on('close', () => {
    gameConns.delete(id);
    if (joined) game.removePlayer(id);
  });
});

app.static(path.join(__dirname, 'public'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\n  ⚒  Forge demo running on http://localhost:${PORT}`);
  console.log(`     API docs:        http://localhost:${PORT}/_routes`);
  console.log(`     Flight recorder: http://localhost:${PORT}/_trace`);
  console.log(`     WebSocket chat:  http://localhost:${PORT}/chat.html`);
  console.log(`     Draw & Guess:    http://localhost:${PORT}/game.html\n`);
});
