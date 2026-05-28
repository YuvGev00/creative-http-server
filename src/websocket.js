'use strict';

// CREATIVE FEATURE — hand-rolled WebSocket (RFC 6455) over the same raw
// `net` sockets. No `ws` library, no `http` server — just the Upgrade
// handshake and frame codec implemented from the spec. `crypto` is used
// only for the SHA-1 accept key (the assignment forbids http/http2, not
// crypto).

const crypto = require('crypto');

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

// Compute the Sec-WebSocket-Accept value from the client's key.
function acceptKey(clientKey) {
  return crypto
    .createHash('sha1')
    .update(clientKey + GUID)
    .digest('base64');
}

// Is this parsed request a WebSocket upgrade?
function isUpgrade(req) {
  return (
    (req.headers['upgrade'] || '').toLowerCase() === 'websocket' &&
    (req.headers['connection'] || '').toLowerCase().includes('upgrade') &&
    !!req.headers['sec-websocket-key']
  );
}

const MAX_WS_FRAME = 10 * 1024 * 1024;

// Decode as many complete frames as `buf` holds. Returns
// { frames: [{opcode, payload}], rest: Buffer, error?: '...' }. A protocol
// violation (oversized frame, or — when `requireMask` is set — an unmasked
// client frame) sets `error` so the caller can close with code 1002 rather
// than keep buffering. The server passes requireMask=true (RFC 6455 §5.1:
// clients MUST mask); the same decoder with requireMask=false also reads
// server→client frames (which are unmasked), e.g. in tests.
function decodeFrames(buf, requireMask = false) {
  const frames = [];
  let offset = 0;

  while (offset + 2 <= buf.length) {
    const b0 = buf[offset];
    const b1 = buf[offset + 1];
    const opcode = b0 & 0x0f;
    const masked = (b1 & 0x80) === 0x80;
    let len = b1 & 0x7f;
    let p = offset + 2;

    if (len === 126) {
      if (p + 2 > buf.length) break;
      len = buf.readUInt16BE(p);
      p += 2;
    } else if (len === 127) {
      if (p + 8 > buf.length) break;
      // Node Buffer can't safely read full 64-bit; assume < 2^53.
      len = Number(buf.readBigUInt64BE(p));
      p += 8;
    }

    // Reject oversized frames: stop decoding and signal a protocol error so
    // we don't sit buffering an attacker-declared multi-GB payload.
    if (len > MAX_WS_FRAME) {
      return { frames, rest: Buffer.alloc(0), error: 'frame too large' };
    }

    // RFC 6455 §5.1: a client MUST mask all frames; a server MUST close on an
    // unmasked one. Only enforced when decoding client→server frames.
    if (requireMask && !masked) {
      return { frames, rest: Buffer.alloc(0), error: 'unmasked client frame' };
    }

    let maskKey;
    if (masked) {
      if (p + 4 > buf.length) break;
      maskKey = buf.slice(p, p + 4);
      p += 4;
    }

    if (p + len > buf.length) break; // frame not fully arrived

    let payload = buf.slice(p, p + len);
    if (masked) {
      const out = Buffer.allocUnsafe(len);
      for (let i = 0; i < len; i++) out[i] = payload[i] ^ maskKey[i & 3];
      payload = out;
    }

    frames.push({ opcode, payload });
    offset = p + len;
  }

  return { frames, rest: buf.slice(offset) };
}

// Encode a server frame (unmasked, single final fragment).
function encodeFrame(payload, opcode = 0x1) {
  const data = Buffer.isBuffer(payload)
    ? payload
    : Buffer.from(String(payload), 'utf8');
  const len = data.length;
  let header;

  if (len < 126) {
    header = Buffer.from([0x80 | opcode, len]);
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  return Buffer.concat([header, data]);
}

const OPCODES = { CONT: 0x0, TEXT: 0x1, BIN: 0x2, CLOSE: 0x8, PING: 0x9, PONG: 0xa };

// A live connection handed to user code: .send(), .close(), and events
// 'message' / 'close'. Kept deliberately small.
class WebSocketConnection {
  constructor(socket) {
    this.socket = socket;
    this.open = true;
    this._handlers = { message: [], close: [] };
  }

  on(event, fn) {
    if (this._handlers[event]) this._handlers[event].push(fn);
    return this;
  }

  _emit(event, ...args) {
    (this._handlers[event] || []).forEach((fn) => fn(...args));
  }

  send(data) {
    if (!this.open) return;
    const isBuf = Buffer.isBuffer(data);
    this.socket.write(encodeFrame(data, isBuf ? OPCODES.BIN : OPCODES.TEXT));
  }

  close(code = 1000) {
    if (!this.open) return;
    this.open = false;
    const body = Buffer.alloc(2);
    body.writeUInt16BE(code, 0);
    this.socket.write(encodeFrame(body, OPCODES.CLOSE));
    this.socket.end();
  }
}

// Perform the handshake and start the read loop. `leftover` is any bytes
// already buffered after the request (rare, but TCP-correct to honor).
function handleUpgrade(req, socket, handler, leftover = Buffer.alloc(0)) {
  const accept = acceptKey(req.headers['sec-websocket-key']);
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
      'Upgrade: websocket\r\n' +
      'Connection: Upgrade\r\n' +
      `Sec-WebSocket-Accept: ${accept}\r\n\r\n`
  );

  const conn = new WebSocketConnection(socket);
  let buffer = leftover;

  // Send a Close frame (code 1002 = protocol error) and tear the socket down.
  const closeProtocol = () => {
    if (!conn.open) return;
    conn.open = false;
    const code = Buffer.from([0x03, 0xea]); // 1002
    try { socket.write(encodeFrame(code, OPCODES.CLOSE)); } catch (_) {}
    conn._emit('close');
    socket.end();
  };

  const pump = () => {
    const { frames, rest, error } = decodeFrames(buffer, true);
    buffer = rest;
    if (error) { closeProtocol(); return; }
    for (const f of frames) {
      if (f.opcode === OPCODES.CLOSE) {
        conn.open = false;
        conn._emit('close');
        socket.end();
        return;
      }
      if (f.opcode === OPCODES.PING) {
        socket.write(encodeFrame(f.payload, OPCODES.PONG));
        continue;
      }
      if (f.opcode === OPCODES.PONG) continue;
      if (f.opcode === OPCODES.TEXT) {
        conn._emit('message', f.payload.toString('utf8'));
      } else if (f.opcode === OPCODES.BIN) {
        conn._emit('message', f.payload);
      }
    }
  };

  socket.on('data', (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    pump();
  });
  socket.on('close', () => {
    if (conn.open) {
      conn.open = false;
      conn._emit('close');
    }
  });
  socket.on('error', () => {
    conn.open = false;
  });

  if (buffer.length) pump();
  handler(conn, req);
}

module.exports = {
  isUpgrade,
  handleUpgrade,
  acceptKey,
  decodeFrames,
  encodeFrame,
  OPCODES,
  WebSocketConnection,
};
