'use strict';

const HEADER_TERMINATOR = Buffer.from('\r\n\r\n');

function extractRequest(buffer, maxBody = Infinity) {
  const headerEnd = buffer.indexOf(HEADER_TERMINATOR);
  if (headerEnd === -1) {

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
  const contentLengths = [];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    const colon = line.indexOf(':');
    if (colon <= 0) continue;
    const key = line.slice(0, colon).toLowerCase().trim();
    const value = line.slice(colon + 1).trim();
    if (key === 'content-length') contentLengths.push(value);
    headers[key] = key in headers ? `${headers[key]}, ${value}` : value;
  }


  const te = (headers['transfer-encoding'] || '').toLowerCase();
  if (te.includes('chunked')) {
    return { error: 'Transfer-Encoding: chunked is not supported' };
  }

  const bodyStart = headerEnd + HEADER_TERMINATOR.length;

  let contentLength = 0;
  if (contentLengths.length > 0) {

    const unique = new Set(contentLengths.map((v) => v.trim()));
    if (unique.size > 1) {
      return { error: 'Conflicting Content-Length headers' };
    }
    const raw = contentLengths[0].trim();

    if (!/^\d+$/.test(raw)) {
      return { error: 'Invalid Content-Length' };
    }
    contentLength = Number(raw);
    if (!Number.isSafeInteger(contentLength)) {
      return { error: 'Invalid Content-Length' };
    }
  }


  if (contentLength > maxBody) {
    return { error: 'Payload Too Large', tooLarge: true };
  }

  if (buffer.length < bodyStart + contentLength) {
    return { complete: false };
  }

  const bodyBuffer = buffer.slice(bodyStart, bodyStart + contentLength);

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
