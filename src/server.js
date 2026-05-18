'use strict';

const net = require('net');
const Router = require('./router');
const Request = require('./request');
const { Response } = require('./response');
const { extractRequest } = require('./http-parser');
const { validate } = require('./validate');
const docs = require('./docs');
const serveStatic = require('./static');

const MAX_REQUEST_BYTES = 5 * 1024 * 1024; // guard against unbounded buffering

// The application object. Chainable, Express-flavoured API plus the creative
// typed-route layer (app.route) and auto docs at /_routes.
class App {
  constructor() {
    this.router = new Router();
    this._docsPath = '/_routes';
    this._registerDocsRoute();
  }

  use(...args) {
    this.router.use(...args);
    return this;
  }

  get(path, handler) {
    return this._verb('GET', path, handler);
  }
  post(path, handler) {
    return this._verb('POST', path, handler);
  }
  put(path, handler) {
    return this._verb('PUT', path, handler);
  }
  delete(path, handler) {
    return this._verb('DELETE', path, handler);
  }
  patch(path, handler) {
    return this._verb('PATCH', path, handler);
  }
  all(path, handler) {
    return this._verb('ALL', path, handler);
  }

  _verb(method, path, handler) {
    this.router.add(method, path, handler);
    return this;
  }

  // CREATIVE: declarative typed route. Validates req.body against `body`
  // schema and short-circuits with a structured 400 before the handler runs.
  // The schema + description are stored as metadata for the live docs page.
  route({ method = 'GET', path, body: bodySchema, description, handler }) {
    const wrapped = async (req, res) => {
      if (bodySchema) {
        const { valid, errors } = validate(bodySchema, req.body);
        if (!valid) {
          return res.status(400).json({
            error: 'Validation failed',
            details: errors,
          });
        }
      }
      return handler(req, res);
    };
    this.router.add(method, path, wrapped, { bodySchema, description });
    return this;
  }

  static(rootDir, options) {
    this.router.use(serveStatic(rootDir, options));
    return this;
  }

  _registerDocsRoute() {
    this.router.add(
      'GET',
      this._docsPath,
      (req, res) => {
        if ((req.query.format || '') === 'json') {
          return res.json(docs.renderJson(this.router));
        }
        res
          .status(200)
          .set('Content-Type', 'text/html; charset=utf-8')
          .send(docs.renderHtml(this.router));
      },
      { hidden: true }
    );
  }

  listen(port, callback) {
    const server = net.createServer((socket) => {
      let buffer = Buffer.alloc(0);
      let closed = false;

      socket.on('error', () => {
        closed = true;
      });

      socket.on('data', async (chunk) => {
        if (closed) return;
        buffer = Buffer.concat([buffer, chunk]);

        if (buffer.length > MAX_REQUEST_BYTES) {
          socket.end(
            'HTTP/1.1 413 Payload Too Large\r\nConnection: close\r\nContent-Length: 0\r\n\r\n'
          );
          closed = true;
          return;
        }

        // Drain every complete request currently buffered. TCP may deliver
        // a partial request, a whole one, or several at once.
        while (!closed) {
          const result = extractRequest(buffer);

          if (result.error) {
            socket.end(
              `HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`
            );
            closed = true;
            return;
          }
          if (!result.complete) break; // wait for more bytes

          buffer = buffer.slice(result.bytesConsumed);

          const req = new Request(result.request, socket);
          const res = new Response(socket);

          try {
            await this.router.dispatch(req, res);
            if (!res.sent) {
              res.status(404).json({ error: 'Not Found', path: req.path });
            }
          } catch (err) {
            if (!res.sent) {
              res.status(500).json({
                error: 'Internal Server Error',
                message: err && err.message,
              });
            }
          }

          // We send `Connection: close`, so stop after one request per
          // connection — any pipelined extra is dropped with the socket.
          break;
        }
      });
    });

    server.listen(port, callback);
    this.server = server;
    return server;
  }

  close(cb) {
    if (this.server) this.server.close(cb);
  }
}

function forge() {
  return new App();
}

forge.App = App;
forge.serveStatic = serveStatic;
module.exports = forge;
