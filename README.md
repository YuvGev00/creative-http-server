# ⚒ Forge

A small, expressive HTTP/1.1 web framework built **entirely from scratch** on
Node.js's low-level `net` module — no `http`, `http2`, or third-party HTTP
libraries. Only `net`, `fs`, and `path` are used.

> Full Stack Engineering — PS #1 · Reichman University

## Quick start

```bash
node examples/demo.js      # or: npm start
# → http://localhost:3000
# → http://localhost:3000/_routes   (live API reference)

node test/smoke.js         # or: npm test  (10 assertions, raw-socket driven)
```

## API design choices

I chose an **Express-flavoured, chainable core** so the framework is instantly
familiar and easy to evaluate against the requirements, then added **one
cohesive creative feature** that builds naturally on top of it.

### Core API

```js
const forge = require('./src/server');
const app = forge();

app.use((req, res, next) => { console.log(req.method, req.path); next(); });

app.get('/api/users/:id', (req, res) => {
  res.json({ id: req.params.id });          // params, query, headers, body
});

app.post('/api/echo', (req, res) => {
  res.status(201).json(req.body);           // chainable status().json()
});

app.static('./public');                     // static files, like express.static()

app.listen(3000, () => console.log('up'));
```

- **Request** — `req.method`, `req.path`, `req.query`, `req.params`,
  `req.headers`, `req.body` (lazily parsed as JSON / urlencoded / text by
  `Content-Type`), `req.rawBody`, `req.ip`.
- **Response** — chainable `status()`, `set()`, `type()`, `json()`, `send()`,
  `redirect()`, `sendFile()` (streamed, correct MIME + `Content-Length`).
- **Router** — `:param` and trailing `*` wildcard patterns; per-method tables;
  `app.use(fn)` / `app.use('/prefix', fn)` middleware running in registration
  order with `next()`; automatic `404` and `500` fallbacks.
- **Static** — virtual mount paths, directory `index.html`, MIME inference,
  and **directory-traversal protection** (resolved path must stay inside the
  served root, checked before any filesystem access).

### Creative feature — Typed routes with auto-validation + a live, self-updating API reference

`app.route({ ... })` registers a route with a **declarative body schema**. The
framework validates `req.body` automatically and short-circuits with a
structured `400` before your handler runs — you never write validation
boilerplate:

```js
app.route({
  method: 'POST',
  path: '/api/users',
  description: 'Create a user.',
  body: {
    name:  { type: 'string', required: true, min: 2, max: 40 },
    email: { type: 'string', required: true, pattern: /^[^@\s]+@[^@\s]+\.[^@\s]+$/ },
    role:  { type: 'string', enum: ['admin', 'member'] },
  },
  handler: (req, res) => res.status(201).json({ created: true }),
});
```

Invalid request → automatic, descriptive response:

```json
{ "error": "Validation failed",
  "details": [ { "field": "email", "message": "\"email\" is required" } ] }
```

Because every route carries its schema as metadata, the framework serves a
**live API reference** at `GET /_routes` — a styled HTML page (or
`?format=json`) generated directly from the registered routes, so the docs can
never drift from the implementation.

## How it works under the hood

1. **TCP, not HTTP.** `net.createServer` gives raw sockets. A single `'data'`
   event is *not* one HTTP request — TCP delivers arbitrary byte chunks.
2. **Per-socket buffering** (`src/server.js` + `src/http-parser.js`): bytes are
   accumulated in a `Buffer`; a request is dispatched only once the header
   terminator `\r\n\r\n` **and** the full `Content-Length` body have arrived.
   Operating on Buffers keeps binary/non-ASCII bodies intact. The
   `test/smoke.js` "split request" case writes one request in two TCP chunks to
   prove this works — the naive "one data event = one request" approach (as in
   the assignment's reference snippets) fails this.
3. **Manual parsing**: request line → method/target/version, query string,
   lower-cased headers, body slice.
4. **Manual response building**: `HTTP/1.1 <code> <text>\r\n`, headers
   (auto `Content-Length`, `Date`, `Server`, `Connection: close`), blank line,
   body.

## Project structure

```
src/server.js       App API, net server, per-socket request buffering
src/http-parser.js  Buffer-safe, Content-Length-aware request extraction
src/request.js      Request wrapper (lazy body parsing)
src/response.js     Chainable response (json/send/sendFile/redirect)
src/router.js       :param/wildcard routing + middleware chain
src/static.js       Static serving + traversal guard
src/mime.js         Extension → MIME map
src/validate.js     Declarative schema validator   (creative)
src/docs.js         Live /_routes reference renderer (creative)
examples/demo.js    Wires every feature together
test/smoke.js       10 raw-socket assertions, exits non-zero on failure
```

## Verification

`npm test` boots the framework on an ephemeral port and drives it with a raw
`net` client, asserting: JSON routes, path params, valid/invalid typed-route
validation, static MIME, traversal blocking, the live docs (HTML + JSON), a
split-across-TCP-chunks request, and 404 handling.

## Possible extensions (out of scope here)

HTTP keep-alive connection reuse, TLS/HTTPS, HTTP/2, chunked
transfer-encoding, `multipart/form-data`, and cookie/session support.

— Yuval Geva
