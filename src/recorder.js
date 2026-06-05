'use strict';

class Recorder {
  constructor(limit = 50) {
    this.limit = limit;
    this.entries = [];
    this.seq = 0;
  }

  start(req) {
    const entry = {
      id: ++this.seq,
      time: new Date().toISOString(),
      method: req.method,
      path: req.path,
      ip: req.ip,
      steps: [],
      route: null,
      validation: null,
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
