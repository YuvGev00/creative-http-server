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
    this.statusCode = code;
    return this;
  }

  set(key, value) {
    // Reject CR/LF in header name or value — otherwise a caller passing
    // attacker-controlled data could inject extra headers or split the
    // response (CRLF / response-splitting).
    if (/[\r\n]/.test(String(key)) || /[\r\n]/.test(String(value))) {
      throw new Error('Invalid characters (CR/LF) in header');
    }
    this.headers[key] = value;
    return this;
  }

  type(contentType) {
    this.headers['Content-Type'] = contentType;
    return this;
  }

  _writeHead(bodyLength) {
    const text = STATUS_TEXT[this.statusCode] || 'Unknown';
    let head = `HTTP/1.1 ${this.statusCode} ${text}\r\n`;

    if (bodyLength !== null && this.headers['Content-Length'] === undefined) {
      this.headers['Content-Length'] = bodyLength;
    }
    if (this.headers['Connection'] === undefined) {
      this.headers['Connection'] = 'close';
    }
    if (this.headers['Date'] === undefined) {
      this.headers['Date'] = new Date().toUTCString();
    }
    if (this.headers['Server'] === undefined) {
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
    this._markSent();

    let bodyBuf;
    if (Buffer.isBuffer(body)) {
      bodyBuf = body;
      if (this.headers['Content-Type'] === undefined) {
        this.headers['Content-Type'] = 'application/octet-stream';
      }
    } else if (body === undefined || body === null) {
      bodyBuf = Buffer.alloc(0);
    } else if (typeof body === 'object') {
      return this.json(body);
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
    if (!this._bodySuppressed() && bodyBuf.length) this.socket.write(bodyBuf);
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
    if (!this._bodySuppressed()) this.socket.write(body);
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
      // HEAD: same headers (incl. Content-Length) as GET, but no body.
      if (this.method === 'HEAD') {
        this.socket.end();
        return;
      }
      const stream = fs.createReadStream(filePath);
      stream.pipe(this.socket);
      stream.on('error', () => this.socket.destroy());
    });
    return this;
  }
}

module.exports = { Response, STATUS_TEXT };
