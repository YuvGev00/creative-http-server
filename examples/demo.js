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

// --- Required feature 2: static file serving ---
app.static(path.join(__dirname, 'public'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\n  ⚒  Forge demo running on http://localhost:${PORT}`);
  console.log(`     API docs:  http://localhost:${PORT}/_routes\n`);
});
