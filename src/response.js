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

class Response {
  constructor(socket) {
    this.socket = socket;
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

  status(code) {
    this.statusCode = code;
    return this;
  }

  set(key, value) {
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

    const head = this._writeHead(bodyBuf.length);
    this.socket.write(head);
    if (bodyBuf.length) this.socket.write(bodyBuf);
    this.socket.end();
    return this;
  }

  json(data) {
    if (this.sent) return this;
    const body = Buffer.from(JSON.stringify(data, null, 2), 'utf8');
    this.headers['Content-Type'] = 'application/json; charset=utf-8';
    this._markSent();
    const head = this._writeHead(body.length);
    this.socket.write(head);
    this.socket.write(body);
    this.socket.end();
    return this;
  }

  redirect(location, code = 302) {
    if (this.sent) return this;
    this.statusCode = code;
    this.headers['Location'] = location;
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
      const stream = fs.createReadStream(filePath);
      stream.pipe(this.socket);
      stream.on('error', () => this.socket.destroy());
    });
    return this;
  }
}

module.exports = { Response, STATUS_TEXT };
