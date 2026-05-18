'use strict';

const fs = require('fs');
const path = require('path');
const { getMimeType } = require('./mime');

const STATUS_TEXT = {
  200: 'OK',
  201: 'Created',
  204: 'No Content',
  301: 'Moved Permanently',
  302: 'Found',
  304: 'Not Modified',
  400: 'Bad Request',
  401: 'Unauthorized',
  403: 'Forbidden',
  404: 'Not Found',
  405: 'Method Not Allowed',
  409: 'Conflict',
  413: 'Payload Too Large',
  415: 'Unsupported Media Type',
  422: 'Unprocessable Entity',
  500: 'Internal Server Error',
  501: 'Not Implemented',
  503: 'Service Unavailable',
};

// Per RFC 7230/7231 these never carry a message body.
const BODYLESS_STATUS = new Set([204, 304]);

class Response {
  constructor(socket, method = 'GET') {
    this.socket = socket;
    // HEAD must return identical headers to GET but no body.
    this.method = String(method).toUpperCase();
    this.statusCode = 200;
    this.headers = {};
    this.sent = false;
    this._bytesWritten = 0; // body bytes, for the Flight Recorder
    // Resolves the moment a response is flushed. dispatch() awaits this so a
    // middleware that responds without calling next() (e.g. static file
    // serving) still settles the request cleanly.
    this.done = new Promise((resolve) => {
      this._resolveDone = resolve;
    });
  }

  _markSent() {
    this.sent = true;
    if (this._resolveDone) this._resolveDone();
  }

  // True when the response must omit its body (HEAD request, or a status
  // that is defined to never have one). Content-Length headers are still
  // sent so HEAD mirrors the equivalent GET.
  _bodySuppressed() {
    return this.method === 'HEAD' || BODYLESS_STATUS.has(this.statusCode);
  }

  status(code) {
    // Coerce and bound-check: a non-numeric status (e.g. user input) would
    // otherwise be written verbatim into the status line and could inject
    // headers / split the response.
    const n = Number(code);
    if (!Number.isInteger(n) || n < 100 || n > 599) {
      throw new Error(`Invalid HTTP status code: ${code}`);
    }
    this.statusCode = n;
    return this;
  }

  // Canonicalize a header name so set('content-length') and the auto
  // 'Content-Length' don't both get emitted (duplicate-header bug).
  _canonical(name) {
    const lower = String(name).toLowerCase();
    for (const existing of Object.keys(this.headers)) {
      if (existing.toLowerCase() === lower) return existing;
    }
    return name;
  }

  set(key, value) {
    // Reject CR/LF in header name or value — otherwise a caller passing
    // attacker-controlled data could inject extra headers or split the
    // response (CRLF / response-splitting).
    if (/[\r\n]/.test(String(key)) || /[\r\n]/.test(String(value))) {
      throw new Error('Invalid characters (CR/LF) in header');
    }
    this.headers[this._canonical(key)] = value;
    return this;
  }

  type(contentType) {
    this.headers[this._canonical('Content-Type')] = contentType;
    return this;
  }

  // Case-insensitive "is this header already set by the caller?"
  _has(name) {
    const lower = name.toLowerCase();
    return Object.keys(this.headers).some((k) => k.toLowerCase() === lower);
  }

  _writeHead(bodyLength) {
    const text = STATUS_TEXT[this.statusCode] || 'Unknown';
    let head = `HTTP/1.1 ${this.statusCode} ${text}\r\n`;

    // Only add managed defaults if the caller hasn't already set them
    // (under any casing) — avoids emitting duplicate Content-Length etc.
    if (bodyLength !== null && !this._has('Content-Length')) {
      this.headers['Content-Length'] = bodyLength;
    }
    if (!this._has('Connection')) {
      this.headers['Connection'] = 'close';
    }
    if (!this._has('Date')) {
      this.headers['Date'] = new Date().toUTCString();
    }
    if (!this._has('Server')) {
      this.headers['Server'] = 'Forge/1.0';
    }

    for (const [k, v] of Object.entries(this.headers)) {
      // Final safety net: never emit a header containing CR/LF.
      if (/[\r\n]/.test(String(k)) || /[\r\n]/.test(String(v))) continue;
      head += `${k}: ${v}\r\n`;
    }
    head += '\r\n';
    return head;
  }

  // Send a Buffer or string body and close the connection.
  send(body) {
    if (this.sent) return this;

    // Delegate objects to json() BEFORE marking sent — otherwise json()
    // would see sent===true, bail, and the connection would hang forever.
    if (
      body !== null &&
      body !== undefined &&
      typeof body === 'object' &&
      !Buffer.isBuffer(body)
    ) {
      return this.json(body);
    }

    this._markSent();

    let bodyBuf;
    if (Buffer.isBuffer(body)) {
      bodyBuf = body;
      if (this.headers['Content-Type'] === undefined) {
        this.headers['Content-Type'] = 'application/octet-stream';
      }
    } else if (body === undefined || body === null) {
      bodyBuf = Buffer.alloc(0);
    } else {
      bodyBuf = Buffer.from(String(body), 'utf8');
      if (this.headers['Content-Type'] === undefined) {
        this.headers['Content-Type'] = 'text/plain; charset=utf-8';
      }
    }

    // HEAD mirrors GET's headers (incl. Content-Length) but sends no body.
    // 204/304 carry neither a body nor a Content-Length.
    const bodyless = BODYLESS_STATUS.has(this.statusCode);
    const head = this._writeHead(bodyless ? null : bodyBuf.length);
    this.socket.write(head);
    if (!this._bodySuppressed() && bodyBuf.length) {
      this.socket.write(bodyBuf);
      this._bytesWritten = bodyBuf.length;
    }
    this.socket.end();
    return this;
  }

  json(data) {
    if (this.sent) return this;
    const body = Buffer.from(JSON.stringify(data, null, 2), 'utf8');
    this.headers['Content-Type'] = 'application/json; charset=utf-8';
    this._markSent();
    const bodyless = BODYLESS_STATUS.has(this.statusCode);
    const head = this._writeHead(bodyless ? null : body.length);
    this.socket.write(head);
    if (!this._bodySuppressed()) {
      this.socket.write(body);
      this._bytesWritten = body.length;
    }
    this.socket.end();
    return this;
  }

  redirect(location, code = 302) {
    if (this.sent) return this;
    this.statusCode = code;
    this.set('Location', location); // CR/LF-guarded
    return this.send('');
  }

  // Stream a file with correct MIME + Content-Length. Calls onError(err)
  // instead of throwing so callers can fall back (e.g. to a 404).
  sendFile(filePath, onError) {
    if (this.sent) return this;
    fs.stat(filePath, (err, stats) => {
      if (err || !stats.isFile()) {
        if (onError) return onError(err || new Error('Not a file'));
        return this.status(404).send('Not Found');
      }
      this._markSent();
      if (this.headers['Content-Type'] === undefined) {
        this.headers['Content-Type'] = getMimeType(filePath);
      }
      const head = this._writeHead(stats.size);
      this.socket.write(head);
      this._bytesWritten = stats.size;
      // HEAD: same headers (incl. Content-Length) as GET, but no body.
      if (this.method === 'HEAD') {
        this.socket.end();
        return;
      }
      const stream = fs.createReadStream(filePath);
      const cleanup = () => stream.destroy();
      // If the client disconnects mid-transfer, tear the read stream down
      // so the file descriptor isn't leaked.
      this.socket.once('close', cleanup);
      this.socket.once('error', cleanup);
      stream.on('error', () => this.socket.destroy());
      stream.on('end', () => {
        this.socket.removeListener('close', cleanup);
        this.socket.removeListener('error', cleanup);
      });
      stream.pipe(this.socket);
    });
    return this;
  }

  // ---- CREATIVE: HTTP/1.1 chunked transfer encoding ----
  //
  // Open a response with `Transfer-Encoding: chunked` and no Content-Length.
  // Returns a small writer: .write(data) emits one chunk (size in hex CRLF
  // data CRLF), .end() writes the terminating zero-length chunk. The browser
  // renders each chunk the instant it arrives, so a page can visibly
  // assemble itself.
  chunked(contentType = 'text/html; charset=utf-8') {
    if (this.sent) return null;
    this._markSent();
    this.headers['Content-Type'] = contentType;
    this.headers['Transfer-Encoding'] = 'chunked';
    // Build the head WITHOUT a Content-Length (null) and strip the default
    // 'Connection: close' so the framing — not EOF — delimits the body.
    const head = this._writeHead(null);
    this.socket.write(head);

    const sock = this.socket;
    let ended = false;
    return {
      write: (data) => {
        if (ended) return;
        const buf = Buffer.isBuffer(data)
          ? data
          : Buffer.from(String(data), 'utf8');
        if (buf.length === 0) return;
        this._bytesWritten += buf.length;
        sock.write(buf.length.toString(16) + '\r\n');
        sock.write(buf);
        sock.write('\r\n');
      },
      end: (data) => {
        if (ended) return;
        if (data) {
          const buf = Buffer.isBuffer(data)
            ? data
            : Buffer.from(String(data), 'utf8');
          if (buf.length) {
            sock.write(buf.length.toString(16) + '\r\n');
            sock.write(buf);
            sock.write('\r\n');
          }
        }
        ended = true;
        sock.write('0\r\n\r\n'); // terminating chunk
        sock.end();
      },
    };
  }

  // ---- CREATIVE: Server-Sent Events (text/event-stream) ----
  //
  // A long-lived response that pushes named events to the browser's
  // EventSource. Different real-time mechanism from WebSockets: one-way,
  // plain HTTP, auto-reconnecting in the browser.
  sse() {
    if (this.sent) return null;
    this._markSent();
    this.headers['Content-Type'] = 'text/event-stream; charset=utf-8';
    this.headers['Cache-Control'] = 'no-cache';
    this.headers['Connection'] = 'keep-alive';
    const head = this._writeHead(null);
    this.socket.write(head);

    const sock = this.socket;
    let closed = false;
    sock.on('close', () => {
      closed = true;
    });
    return {
      send: (data, event) => {
        if (closed) return;
        let frame = '';
        if (event) frame += `event: ${event}\n`;
        const payload =
          typeof data === 'string' ? data : JSON.stringify(data);
        // Each line of the payload needs its own "data:" prefix.
        for (const line of String(payload).split('\n')) {
          frame += `data: ${line}\n`;
        }
        frame += '\n';
        this._bytesWritten += Buffer.byteLength(frame);
        sock.write(frame);
      },
      close: () => {
        if (closed) return;
        closed = true;
        sock.end();
      },
      get closed() {
        return closed;
      },
    };
  }
}

module.exports = { Response, STATUS_TEXT };
