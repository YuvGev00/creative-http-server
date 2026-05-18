'use strict';

// CREATIVE FEATURE — Request Flight Recorder.
//
// A bounded in-memory ring buffer that captures the lifecycle of recent
// requests: which middleware ran, whether typed-route validation passed,
// handler timing, final status and response size. Exposed live at /_trace
// (HTML) and /_trace?format=json. Bounded so it can never leak memory.

class Recorder {
  constructor(limit = 50) {
    this.limit = limit;
    this.entries = [];
    this.seq = 0;
  }

  // Begin a trace for one request; returns a handle the dispatcher fills in.
  start(req) {
    const entry = {
      id: ++this.seq,
      time: new Date().toISOString(),
      method: req.method,
      path: req.path,
      ip: req.ip,
      steps: [], // { name, ms } per middleware / phase
      route: null,
      validation: null, // 'passed' | 'failed' | null
      status: null,
      bytes: null,
      totalMs: null,
      _t0: process.hrtime.bigint(),
    };
    return entry;
  }

  step(entry, name, startNs) {
    if (!entry) return;
    const ms = Number(process.hrtime.bigint() - startNs) / 1e6;
    entry.steps.push({ name, ms: round(ms) });
  }

  finish(entry, res) {
    if (!entry) return;
    entry.totalMs = round(Number(process.hrtime.bigint() - entry._t0) / 1e6);
    entry.status = res.statusCode;
    entry.bytes = res._bytesWritten || 0;
    // A typed route that returned 400 means schema validation rejected it.
    if (entry.validation === 'passed' && res.statusCode === 400) {
      entry.validation = 'failed';
    }
    delete entry._t0;

    this.entries.unshift(entry);
    if (this.entries.length > this.limit) this.entries.length = this.limit;
  }

  list() {
    return this.entries;
  }
}

function round(n) {
  return Math.round(n * 1000) / 1000;
}

module.exports = Recorder;
