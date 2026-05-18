'use strict';

// Routing + middleware. Path patterns support :params (/users/:id) and a
// trailing wildcard (/static/*). Every registered route also keeps metadata
// so the live /_routes docs page can describe the whole API.

function compilePath(pattern) {
  const paramNames = [];
  let regexStr = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&') // escape regex specials
    .replace(/:([A-Za-z_][A-Za-z0-9_]*)/g, (_, name) => {
      paramNames.push(name);
      return '([^/]+)';
    })
    .replace(/\\\*/g, '(.*)'); // wildcard (the \* is from the escape pass)
  if (pattern.includes('*')) paramNames.push('wildcard');
  return { regex: new RegExp(`^${regexStr}/?$`), paramNames };
}

class Router {
  constructor() {
    this.routes = []; // { method, pattern, regex, paramNames, handler, meta }
    this.middleware = []; // { prefix, fn }
  }

  use(prefixOrFn, maybeFn) {
    if (typeof prefixOrFn === 'function') {
      this.middleware.push({ prefix: '/', fn: prefixOrFn });
    } else {
      this.middleware.push({ prefix: prefixOrFn, fn: maybeFn });
    }
    return this;
  }

  add(method, pattern, handler, meta = {}) {
    const { regex, paramNames } = compilePath(pattern);
    this.routes.push({
      method: method.toUpperCase(),
      pattern,
      regex,
      paramNames,
      handler,
      meta,
    });
    return this;
  }

  match(method, pathname) {
    for (const route of this.routes) {
      if (route.method !== method && route.method !== 'ALL') continue;
      const m = pathname.match(route.regex);
      if (!m) continue;
      const params = {};
      route.paramNames.forEach((name, i) => {
        params[name] = decodeSafe(m[i + 1]);
      });
      return { route, params };
    }
    return null;
  }

  // Run matching middleware in registration order, then the route handler.
  // Middleware calls next() to continue; not calling it ends the chain.
  //
  // Middleware may defer next() inside an async callback (e.g. fs.stat in the
  // static handler), so dispatch resolves only once the chain has truly
  // finished — either a response was sent or every step ran. The server must
  // not send its own fallback before this promise settles.
  dispatch(req, res) {
    const chain = this.middleware.filter(
      (m) =>
        m.prefix === '/' ||
        req.path === m.prefix ||
        req.path.startsWith(m.prefix.replace(/\/$/, '') + '/')
    );

    const chainDone = new Promise((resolve, reject) => {
      let idx = 0;

      const runNext = async () => {
        try {
          if (res.sent) return resolve();

          if (idx < chain.length) {
            const mw = chain[idx++];
            await mw.fn(req, res, runNext);
            return;
          }

          const matched = this.match(req.method, req.path);
          if (!matched) {
            if (!res.sent) {
              res.status(404).json({ error: 'Not Found', path: req.path });
            }
            return resolve();
          }
          req.params = matched.params;
          req.route = matched.route.pattern;
          await matched.route.handler(req, res);
          return resolve();
        } catch (err) {
          reject(err);
        }
      };

      runNext();
    });

    // Settle as soon as a response is flushed (covers middleware that
    // responds without calling next, e.g. static file serving) OR the
    // middleware/route chain runs to completion.
    return Promise.race([chainDone, res.done]);
  }
}

function decodeSafe(v) {
  if (v === undefined) return v;
  try {
    return decodeURIComponent(v);
  } catch {
    return v;
  }
}

module.exports = Router;
