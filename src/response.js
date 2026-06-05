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

const BODYLESS_STATUS = new Set([204, 304]);

class Response {
  constructor(socket, method = 'GET') {
    this.socket = socket;

    this.method = String(method).toUpperCase();
    this.statusCode = 200;
    this.headers = {};
    this.sent = false;
    this._bytesWritten = 0;


    this.done = new Promise((resolve) => {
      this._resolveDone = resolve;
    });
  }

  _markSent() {
    this.sent = true;
    if (this._resolveDone) this._resolveDone();
  }



  _bodySuppressed() {
    return this.method === 'HEAD' || BODYLESS_STATUS.has(this.statusCode);
  }

  status(code) {


    const n = Number(code);
    if (!Number.isInteger(n) || n < 100 || n > 599) {
      throw new Error(`Invalid HTTP status code: ${code}`);
    }
    this.statusCode = n;
    return this;
  }


  _canonical(name) {
    const lower = String(name).toLowerCase();
    for (const existing of Object.keys(this.headers)) {
      if (existing.toLowerCase() === lower) return existing;
    }
    return name;
  }

  set(key, value) {


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

  _has(name) {
    const lower = name.toLowerCase();
    return Object.keys(this.headers).some((k) => k.toLowerCase() === lower);
  }

  _writeHead(bodyLength) {
    const text = STATUS_TEXT[this.statusCode] || 'Unknown';
    let head = `HTTP/1.1 ${this.statusCode} ${text}\r\n`;


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

      if (/[\r\n]/.test(String(k)) || /[\r\n]/.test(String(v))) continue;
      head += `${k}: ${v}\r\n`;
    }
    head += '\r\n';
    return head;
  }

  send(body) {
    if (this.sent) return this;


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
    this.set('Location', location);
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

      if (this.method === 'HEAD') {
        this.socket.end();
        return;
      }
      const stream = fs.createReadStream(filePath);
      const cleanup = () => stream.destroy();

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
}

module.exports = { Response, STATUS_TEXT };
