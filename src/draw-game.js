'use strict';

// CREATIVE FEATURE — multiplayer Draw & Guess (Pictionary).
//
// Pure game state + rules, deliberately transport-agnostic so it can be
// unit-tested without sockets. The WebSocket route in the demo just relays
// JSON messages in and broadcasts the resulting events out.

const WORDS = [
  'cat', 'house', 'tree', 'car', 'sun', 'fish', 'star', 'boat',
  'apple', 'flower', 'guitar', 'rocket', 'pizza', 'snake', 'cloud',
  'robot', 'ghost', 'crown', 'key', 'heart', 'moon', 'bridge',
];

const ROUND_MS = 70 * 1000;

function pickWord(exclude) {
  let w;
  do {
    w = WORDS[Math.floor(Math.random() * WORDS.length)];
  } while (w === exclude && WORDS.length > 1);
  return w;
}

class DrawGame {
  constructor() {
    this.players = new Map(); // id -> { id, name, score }
    this.order = []; // player ids, drawing rotation
    this.drawerIdx = -1;
    this.word = null;
    this.roundActive = false;
    this.roundEndsAt = 0;
    this.guessedThisRound = new Set();
    this._listeners = [];
  }

  // Subscribe to broadcastable events: fn(event) where event = {type,...}.
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
    this.players.set(id, { id, name: clean, score: 0 });
    this.order.push(id);
    this._emit({ type: 'players', players: this.publicPlayers() });
    // First two players present -> start a round.
    if (!this.roundActive && this.players.size >= 2) this.startRound();
    else this._emit(this.stateFor(id));
    return this.players.get(id);
  }

  removePlayer(id) {
    this.players.delete(id);
    const wasDrawer = this.drawerId === id;
    this.order = this.order.filter((p) => p !== id);
    if (this.drawerIdx >= this.order.length) this.drawerIdx = 0;
    this._emit({ type: 'players', players: this.publicPlayers() });
    if (this.players.size < 2) {
      this.roundActive = false;
      this.word = null;
      this._emit({ type: 'system', text: 'Waiting for 2+ players…' });
    } else if (wasDrawer && this.roundActive) {
      this.startRound(); // drawer left mid-round -> new round
    }
  }

  publicPlayers() {
    return [...this.players.values()].map((p) => ({
      id: p.id,
      name: p.name,
      score: p.score,
      drawing: p.id === this.drawerId,
    }));
  }

  // State tailored per recipient: only the drawer learns the word.
  stateFor(id) {
    return {
      type: 'state',
      roundActive: this.roundActive,
      drawerId: this.drawerId,
      drawerName: this.drawerId
        ? (this.players.get(this.drawerId) || {}).name
        : null,
      youAreDrawer: id === this.drawerId,
      word: id === this.drawerId ? this.word : null,
      wordLength: this.word ? this.word.length : 0,
      endsAt: this.roundEndsAt,
      players: this.publicPlayers(),
    };
  }

  startRound() {
    if (this.players.size < 2) return;
    this.drawerIdx = (this.drawerIdx + 1) % this.order.length;
    this.word = pickWord(this.word);
    this.roundActive = true;
    this.roundEndsAt = Date.now() + ROUND_MS;
    this.guessedThisRound = new Set();
    this._emit({ type: 'clear' });
    this._emit({
      type: 'system',
      text: `New round! ${
        (this.players.get(this.drawerId) || {}).name
      } is drawing.`,
    });
    // Each client gets its own state (drawer sees the word).
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
          ? `Time! The word was "${revealed}".`
          : `Round over. The word was "${revealed}".`,
    });
    this._emit({ type: 'players', players: this.publicPlayers() });
  }

  // A non-drawer submits a guess. Returns the outcome for the caller.
  guess(id, text) {
    const player = this.players.get(id);
    if (!player) return { ok: false };
    const guess = String(text || '').trim();
    if (!guess) return { ok: false };

    // Drawer can't guess; nobody guesses outside an active round.
    if (!this.roundActive || id === this.drawerId) {
      this._emit({ type: 'chat', name: player.name, text: guess });
      return { ok: true, correct: false };
    }

    if (guess.toLowerCase() === this.word.toLowerCase()) {
      if (this.guessedThisRound.has(id)) return { ok: true, correct: true };
      this.guessedThisRound.add(id);
      // Faster correct guesses score more; drawer also earns a point.
      const remaining = Math.max(0, this.roundEndsAt - Date.now());
      const points = 100 + Math.round((remaining / ROUND_MS) * 100);
      player.score += points;
      const drawer = this.players.get(this.drawerId);
      if (drawer) drawer.score += 50;
      this._emit({
        type: 'system',
        text: `${player.name} guessed it! (+${points})`,
      });
      this._emit({ type: 'players', players: this.publicPlayers() });

      // Everyone (except drawer) guessed -> end early.
      const guessers = this.players.size - 1;
      if (this.guessedThisRound.size >= guessers) {
        this.endRound('all');
        setTimeout(() => this.startRound(), 2500);
      }
      return { ok: true, correct: true };
    }

    // Wrong guess -> shows in chat for everyone.
    this._emit({ type: 'chat', name: player.name, text: guess });
    return { ok: true, correct: false };
  }

  // Called by a periodic ticker (server) to enforce the time limit.
  tick() {
    if (this.roundActive && Date.now() >= this.roundEndsAt) {
      this.endRound('time');
      setTimeout(() => this.startRound(), 2500);
    }
  }
}

module.exports = { DrawGame, WORDS, ROUND_MS };
