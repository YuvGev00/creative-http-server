'use strict';

// Friendly wrapper around the raw parsed request. Gives handlers an
// Express-ish surface: req.method, req.path, req.query, req.params,
// req.headers, req.body (lazily JSON-parsed when appropriate).

class Request {
  constructor(parsed, socket) {
    this.method = parsed.method;
    this.path = parsed.path;
    this.rawPath = parsed.rawPath;
    this.query = parsed.query;
    this.headers = parsed.headers;
    this.version = parsed.version;
    this.params = {};
    this.socket = socket;
    this.ip = socket.remoteAddress;

    this._rawBody = parsed.body; // Buffer
    this._parsedBody = undefined;
  }

  get(name) {
    return this.headers[String(name).toLowerCase()];
  }

  get rawBody() {
    return this._rawBody;
  }

  get text() {
    return this._rawBody.toString('utf8');
  }

  // Lazily parse the body. JSON when Content-Type says so (or it looks like
  // JSON), otherwise the raw string. Cached after first access.
  get body() {
    if (this._parsedBody !== undefined) return this._parsedBody;

    const raw = this._rawBody;
    if (!raw || raw.length === 0) {
      this._parsedBody = {};
      return this._parsedBody;
    }

    const type = (this.headers['content-type'] || '').toLowerCase();
    const asString = raw.toString('utf8');

    if (type.includes('application/json')) {
      try {
        this._parsedBody = JSON.parse(asString);
      } catch {
        this._parsedBody = { _raw: asString, _error: 'Invalid JSON body' };
      }
    } else if (type.includes('application/x-www-form-urlencoded')) {
      this._parsedBody = parseUrlEncoded(asString);
    } else {
      this._parsedBody = asString;
    }
    return this._parsedBody;
  }
}

function parseUrlEncoded(str) {
  const out = {};
  for (const pair of str.split('&')) {
    if (!pair) continue;
    const eq = pair.indexOf('=');
    const k = eq === -1 ? pair : pair.slice(0, eq);
    const v = eq === -1 ? '' : pair.slice(eq + 1);
    try {
      out[decodeURIComponent(k.replace(/\+/g, ' '))] = decodeURIComponent(
        v.replace(/\+/g, ' ')
      );
    } catch {
      out[k] = v;
    }
  }
  return out;
}

module.exports = Request;
