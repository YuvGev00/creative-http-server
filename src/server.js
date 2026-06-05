'use strict';

const net = require('net');
const Router = require('./router');
const Request = require('./request');
const { Response } = require('./response');
const { extractRequest } = require('./http-parser');
const { validate } = require('./validate');
const docs = require('./docs');
const serveStatic = require('./static');
const Recorder = require('./recorder');
const traceView = require('./trace-view');
const ws = require('./websocket');

const MAX_REQUEST_BYTES = 5 * 1024 * 1024;
const SOCKET_TIMEOUT_MS = 30 * 1000;

const STATIC_ASSET_RE = /\.(css|js|mjs|svg|png|jpe?g|gif|ico|webp|woff2?|ttf|map)$/i;
function isStaticAsset(path) {
  return STATIC_ASSET_RE.test(path);
}

class App {
  constructor() {
    this.router = new Router();
    this.recorder = new Recorder(50);
    this.wsRoutes = new Map();
    this._docsPath = '/_routes';
    this._registerDocsRoute();
    this._registerTraceRoute();
  }


  ws(path, handler) {
    this.wsRoutes.set(path, handler);
    return this;
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
        const wsPaths = [...this.wsRoutes.keys()];
        if ((req.query.format || '') === 'json') {
          return res.json(docs.renderJson(this.router, wsPaths));
        }
        res
          .status(200)
          .set('Content-Type', 'text/html; charset=utf-8')
          .send(docs.renderHtml(this.router, wsPaths));
      },
      { hidden: true }
    );
  }

  _registerTraceRoute() {
    this.router.add(
      'GET',
      '/_trace',
      (req, res) => {
        if ((req.query.format || '') === 'json') {
          return res.json({ recent: this.recorder.list() });
        }
        res
          .status(200)
          .set('Content-Type', 'text/html; charset=utf-8')
          .send(traceView.renderHtml(this.recorder.list()));
      },
      { hidden: true }
    );
  }

  listen(port, callback) {
    const server = net.createServer((socket) => {
      let buffer = Buffer.alloc(0);
      let closed = false;






      let dispatching = false;
      socket.setTimeout(SOCKET_TIMEOUT_MS);
      socket.on('timeout', () => {
        if (!closed && !dispatching) {
          closed = true;
          socket.end(
            'HTTP/1.1 408 Request Timeout\r\nConnection: close\r\nContent-Length: 0\r\n\r\n'
          );
          socket.destroy();
        }
      });

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


        while (!closed) {
          const result = extractRequest(buffer, MAX_REQUEST_BYTES);

          if (result.error) {
            const status = result.tooLarge
              ? '413 Payload Too Large'
              : '400 Bad Request';
            socket.end(
              `HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`
            );
            closed = true;
            return;
          }
          if (!result.complete) break;

          buffer = buffer.slice(result.bytesConsumed);


          dispatching = true;
          socket.setTimeout(0);

          const req = new Request(result.request, socket);

          if (ws.isUpgrade(req) && this.wsRoutes.has(req.path)) {
            socket.setTimeout(0);
            closed = true;
            socket.removeAllListeners('data');
            ws.handleUpgrade(
              req,
              socket,
              this.wsRoutes.get(req.path),
              buffer
            );
            return;
          }
          if (ws.isUpgrade(req)) {
            socket.end(
              'HTTP/1.1 404 Not Found\r\nConnection: close\r\nContent-Length: 0\r\n\r\n'
            );
            closed = true;
            return;
          }

          const res = new Response(socket, req.method);




          const traceEntry =
            req.path === '/_trace' || isStaticAsset(req.path)
              ? null
              : this.recorder.start(req);

          try {
            await this.router.dispatch(
              req,
              res,
              traceEntry
                ? { entry: traceEntry, recorder: this.recorder }
                : null
            );
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
          } finally {
            if (traceEntry) this.recorder.finish(traceEntry, res);
          }


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
