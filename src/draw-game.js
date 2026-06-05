'use strict';

const WORDS = [
  'cat', 'house', 'tree', 'car', 'sun', 'fish', 'star', 'boat',
  'apple', 'flower', 'guitar', 'rocket', 'pizza', 'snake', 'cloud',
  'robot', 'ghost', 'crown', 'key', 'heart', 'moon', 'bridge',
  'butterfly', 'mountain', 'umbrella', 'glasses', 'camera', 'anchor',
];

const ROUND_MS = 75 * 1000;
const MAX_OPS = 5000;

function pickWord(exclude) {
  let w;
  do {
    w = WORDS[Math.floor(Math.random() * WORDS.length)];
  } while (w === exclude && WORDS.length > 1);
  return w;
}

class DrawGame {
  constructor() {
    this.players = new Map();
    this.order = [];
    this.drawerIdx = -1;
    this.word = null;
    this.round = 0;
    this.roundActive = false;
    this.roundEndsAt = 0;
    this.guessedThisRound = new Set();
    this.ops = [];
    this._listeners = [];
  }

  onBroadcast(fn) {
    this._listeners.push(fn);
  }
  _emit(event) {
    for (const fn of this._listeners) fn(event);
  }

  get drawerId() {
    return this.order[this.drawerIdx] || null;
  }

  addPlayer(id, name) {
    const clean = String(name || 'anon').slice(0, 16).trim() || 'anon';
    this.players.set(id, { id, name: clean, score: 0, _spectating: false });

    this.players.get(id)._spectating = this.roundActive;
    this.order.push(id);
    this._emit({ type: 'players', players: this.publicPlayers() });

    if (!this.roundActive && this.players.size >= 2) {
      this.startRound();
    } else {

      this._emit({ ...this.snapshotFor(id), _to: id });
      if (this.roundActive) {
        this._emit({
          type: 'system',
          text: `${clean} joined — watching this round, plays next.`,
        });
      }
    }
    return this.players.get(id);
  }

  removePlayer(id) {
    const p = this.players.get(id);
    if (!p) return;
    this.players.delete(id);
    const wasDrawer = this.drawerId === id;
    const idx = this.order.indexOf(id);
    this.order = this.order.filter((x) => x !== id);

    if (idx !== -1 && idx <= this.drawerIdx) this.drawerIdx--;
    this._emit({ type: 'players', players: this.publicPlayers() });
    this._emit({ type: 'system', text: `${p.name} left.` });

    if (this.players.size < 2) {
      this.roundActive = false;
      this.word = null;
      this._emit({ type: 'system', text: 'Waiting for 2+ players…' });
      this._emit({ type: 'state', ...this._baseState(), youAreDrawer: false });
    } else if (wasDrawer && this.roundActive) {
      this._emit({ type: 'system', text: 'Drawer left — new round.' });
      this.startRound();
    }
  }

  publicPlayers() {
    return [...this.players.values()].map((p) => ({
      id: p.id,
      name: p.name,
      score: p.score,
      drawing: p.id === this.drawerId,
      guessed: this.guessedThisRound.has(p.id),
      spectating: !!p._spectating,
    }));
  }

  _baseState() {
    return {
      round: this.round,
      roundActive: this.roundActive,
      drawerId: this.drawerId,
      drawerName: this.drawerId
        ? (this.players.get(this.drawerId) || {}).name
        : null,
      wordLength: this.word ? this.word.length : 0,
      endsAt: this.roundEndsAt,
      players: this.publicPlayers(),
    };
  }

  stateFor(id) {
    return {
      type: 'state',
      ...this._baseState(),
      youAreDrawer: id === this.drawerId,
      youAreSpectator: !!(this.players.get(id) || {})._spectating,
      word: id === this.drawerId ? this.word : null,
    };
  }


  snapshotFor(id) {
    return { ...this.stateFor(id), type: 'snapshot', ops: this.ops };
  }

  _recordOp(op) {
    this.ops.push(op);
    if (this.ops.length > MAX_OPS) this.ops.splice(0, this.ops.length - MAX_OPS);
  }


  canvasOp(id, op) {
    if (id !== this.drawerId || !this.roundActive) return false;
    if (!op || typeof op !== 'object') return false;
    const t = op.t;
    if (t === 'stroke') {
      const s = op.s || {};
      const clean = {
        t: 'stroke',
        x0: +s.x0, y0: +s.y0, x1: +s.x1, y1: +s.y1,
        c: typeof s.c === 'string' ? s.c.slice(0, 9) : '#111',
        w: Math.min(60, Math.max(1, +s.w || 4)),
        erase: !!s.erase,
      };
      if ([clean.x0, clean.y0, clean.x1, clean.y1].some(Number.isNaN)) return false;
      this._recordOp(clean);
      this._emit({ type: 'op', op: clean });
    } else if (t === 'fill') {
      const clean = {
        t: 'fill',
        c: typeof op.c === 'string' ? op.c.slice(0, 9) : '#111',
      };
      this._recordOp(clean);
      this._emit({ type: 'op', op: clean });
    } else if (t === 'undo') {

      if (this.ops.length) {
        this.ops.pop();

        this._emit({ type: 'replace', ops: this.ops });
      }
    } else if (t === 'clear') {
      this.ops = [];
      this._emit({ type: 'clear' });
    } else {
      return false;
    }
    return true;
  }

  startRound() {
    if (this.players.size < 2) return;
    this.round++;
    this.drawerIdx = (this.drawerIdx + 1) % this.order.length;
    this.word = pickWord(this.word);
    this.roundActive = true;
    this.roundEndsAt = Date.now() + ROUND_MS;
    this.guessedThisRound = new Set();
    this.ops = [];

    for (const p of this.players.values()) p._spectating = false;
    this._emit({ type: 'clear' });
    this._emit({
      type: 'system',
      text: `Round ${this.round}! ${
        (this.players.get(this.drawerId) || {}).name
      } is drawing.`,
    });
    for (const pid of this.players.keys()) {
      this._emit({ ...this.stateFor(pid), _to: pid });
    }
  }

  endRound(reason) {
    if (!this.roundActive) return;
    this.roundActive = false;
    const revealed = this.word;
    this._emit({
      type: 'system',
      text:
        reason === 'time'
          ? `⏰ Time! The word was "${revealed}".`
          : `✓ Round over — the word was "${revealed}".`,
    });
    this._emit({ type: 'reveal', word: revealed });
    this._emit({ type: 'players', players: this.publicPlayers() });
  }

  guess(id, text) {
    const player = this.players.get(id);
    if (!player) return { ok: false };
    const guess = String(text || '').trim().slice(0, 60);
    if (!guess) return { ok: false };

    const isDrawer = id === this.drawerId;
    const canScore =
      this.roundActive &&
      !isDrawer &&
      !player._spectating &&
      !this.guessedThisRound.has(id);

    if (canScore && guess.toLowerCase() === this.word.toLowerCase()) {
      this.guessedThisRound.add(id);
      const remaining = Math.max(0, this.roundEndsAt - Date.now());
      const points = 100 + Math.round((remaining / ROUND_MS) * 100);
      player.score += points;
      const drawer = this.players.get(this.drawerId);
      if (drawer) drawer.score += 50;
      this._emit({
        type: 'system',
        text: `🎉 ${player.name} guessed it! (+${points})`,
      });
      this._emit({ type: 'correct', id, name: player.name });
      this._emit({ type: 'players', players: this.publicPlayers() });

      const guessers = [...this.players.keys()].filter(
        (pid) => pid !== this.drawerId
      ).length;
      if (this.guessedThisRound.size >= guessers && guessers > 0) {
        this.endRound('all');
        setTimeout(() => this.startRound(), 3000);
      }
      return { ok: true, correct: true };
    }

    if (canScore && near(guess, this.word)) {
      this._emit({ type: 'chat', name: player.name, text: guess });
      this._emit({ type: 'system', text: `${player.name} is very close…`, _to: id });
      return { ok: true, correct: false, close: true };
    }

    this._emit({ type: 'chat', name: player.name, text: guess });
    return { ok: true, correct: false };
  }

  tick() {
    if (this.roundActive && Date.now() >= this.roundEndsAt) {
      this.endRound('time');
      setTimeout(() => this.startRound(), 3000);
    }
  }
}

function near(a, b) {
  a = a.toLowerCase();
  b = b.toLowerCase();
  if (a.length !== b.length || a === b) return false;
  let same = 0;
  for (let i = 0; i < a.length; i++) if (a[i] === b[i]) same++;
  return same / b.length >= 0.6;
}

module.exports = { DrawGame, WORDS, ROUND_MS };
