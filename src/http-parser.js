'use strict';

// Manual HTTP/1.1 request parser.
//
// Works on a Buffer so binary/non-ASCII bodies survive intact. The key job is
// answering "do we have ONE complete request yet?" — TCP delivers bytes in
// arbitrary chunks, so a single 'data' event is not a single request.

const HEADER_TERMINATOR = Buffer.from('\r\n\r\n');

// Attempt to extract exactly one complete HTTP request from `buffer`.
// Returns:
//   { complete: false }                          -> need more bytes, wait
//   { complete: true, request, bytesConsumed }   -> a full request was parsed
//   { error: 'message' }                         -> malformed beyond recovery
function extractRequest(buffer, maxBody = Infinity) {
  const headerEnd = buffer.indexOf(HEADER_TERMINATOR);
  if (headerEnd === -1) {
    // Headers not fully received yet.
    return { complete: false };
  }

  const headerText = buffer.slice(0, headerEnd).toString('latin1');
  const lines = headerText.split('\r\n');
  const requestLine = lines[0];

  const parts = requestLine.split(' ');
  if (parts.length !== 3) {
    return { error: 'Malformed request line' };
  }
  const [method, rawTarget, version] = parts;

  const headers = {};
  const contentLengths = []; // track every Content-Length seen, raw
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    const colon = line.indexOf(':');
    if (colon <= 0) continue;
    const key = line.slice(0, colon).toLowerCase().trim();
    const value = line.slice(colon + 1).trim();
    if (key === 'content-length') contentLengths.push(value);
    headers[key] = key in headers ? `${headers[key]}, ${value}` : value;
  }

  // We do not implement chunked decoding; mis-framing a chunked body as a
  // zero-length one is a request-smuggling hazard, so reject it explicitly.
  const te = (headers['transfer-encoding'] || '').toLowerCase();
  if (te.includes('chunked')) {
    return { error: 'Transfer-Encoding: chunked is not supported' };
  }

  const bodyStart = headerEnd + HEADER_TERMINATOR.length;

  let contentLength = 0;
  if (contentLengths.length > 0) {
    // Conflicting duplicate Content-Length headers => smuggling risk.
    const unique = new Set(contentLengths.map((v) => v.trim()));
    if (unique.size > 1) {
      return { error: 'Conflicting Content-Length headers' };
    }
    const raw = contentLengths[0].trim();
    // Must be a bare non-negative integer — reject "5junk", "", "-1", "0x5".
    if (!/^\d+$/.test(raw)) {
      return { error: 'Invalid Content-Length' };
    }
    contentLength = Number(raw);
    if (!Number.isSafeInteger(contentLength)) {
      return { error: 'Invalid Content-Length' };
    }
  }

  // Reject an over-large declared body immediately — before buffering it —
  // so a client can't pin memory by announcing a huge Content-Length.
  if (contentLength > maxBody) {
    return { error: 'Payload Too Large', tooLarge: true };
  }

  // Wait until the full declared body has arrived.
  if (buffer.length < bodyStart + contentLength) {
    return { complete: false };
  }

  const bodyBuffer = buffer.slice(bodyStart, bodyStart + contentLength);

  // Split target into path + query string.
  const qIndex = rawTarget.indexOf('?');
  const rawPath = qIndex === -1 ? rawTarget : rawTarget.slice(0, qIndex);
  const queryString = qIndex === -1 ? '' : rawTarget.slice(qIndex + 1);

  let pathname;
  try {
    pathname = decodeURIComponent(rawPath);
  } catch {
    pathname = rawPath; // keep raw if it has invalid escapes
  }

  const query = parseQuery(queryString);

  const request = {
    method: method.toUpperCase(),
    path: pathname,
    rawPath,
    query,
    headers,
    version,
    body: bodyBuffer,
  };

  return {
    complete: true,
    request,
    bytesConsumed: bodyStart + contentLength,
  };
}

function parseQuery(queryString) {
  const query = {};
  if (!queryString) return query;
  for (const pair of queryString.split('&')) {
    if (!pair) continue;
    const eq = pair.indexOf('=');
    const rawKey = eq === -1 ? pair : pair.slice(0, eq);
    const rawVal = eq === -1 ? '' : pair.slice(eq + 1);
    let key;
    let val;
    try {
      key = decodeURIComponent(rawKey.replace(/\+/g, ' '));
    } catch {
      key = rawKey;
    }
    try {
      val = decodeURIComponent(rawVal.replace(/\+/g, ' '));
    } catch {
      val = rawVal;
    }
    query[key] = val;
  }
  return query;
}

module.exports = { extractRequest, parseQuery };
