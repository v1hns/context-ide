'use strict';

const { Transform } = require('node:stream');

const PASTE_START = '\x1b[200~';
const PASTE_END = '\x1b[201~';

// A paste larger than this many characters, or containing a newline, is
// collapsed to a short placeholder instead of being dumped into the line.
const COLLAPSE_CHARS = 200;

function pasteLabel(index, content) {
  const lines = content.split('\n').length;
  if (lines > 1) return `[Pasted text #${index} +${lines} lines]`;
  return `[Pasted text #${index} +${content.length} chars]`;
}

// Holds the full text of every collapsed paste so the placeholder shown in the
// prompt can be expanded back to its original content when the line is sent.
class PasteStore {
  constructor() {
    this.items = new Map();
    this.counter = 0;
  }

  register(content) {
    const index = (this.counter += 1);
    this.items.set(index, content);
    return { index, placeholder: pasteLabel(index, content) };
  }

  get(index) {
    return this.items.get(index);
  }

  // Returns { text, expanded } where expanded lists the pastes that were
  // substituted. Placeholders whose paste is unknown are left untouched.
  expand(line) {
    const expanded = [];
    const text = String(line).replace(/\[Pasted text #(\d+)(?: \+[^\]]*)?\]/g, (match, digits) => {
      const index = Number(digits);
      const stored = this.items.get(index);
      if (stored == null) return match;
      expanded.push({ index, content: stored, lines: stored.split('\n').length, chars: stored.length });
      return stored;
    });
    return { text, expanded };
  }

  clear() {
    this.items.clear();
    this.counter = 0;
  }
}

class PasteInput extends Transform {
  constructor(options = {}) {
    super(options);
    this.store = options.store || new PasteStore();
    this.collapseChars = options.collapseChars || COLLAPSE_CHARS;
    this.pending = '';
    this.pasteBuffer = '';
    this.pasting = false;
  }

  _transform(chunk, encoding, callback) {
    this.pending += chunk.toString('utf8');
    let output = '';

    while (this.pending) {
      const marker = this.pasting ? PASTE_END : PASTE_START;
      const markerIndex = this.pending.indexOf(marker);
      if (markerIndex !== -1) {
        const segment = this.pending.slice(0, markerIndex);
        if (this.pasting) {
          this.pasteBuffer += segment;
          output += this.finishPaste();
        } else {
          output += segment;
        }
        this.pending = this.pending.slice(markerIndex + marker.length);
        this.pasting = !this.pasting;
        continue;
      }

      const possibleMarkerLength = trailingMarkerPrefixLength(this.pending, marker);
      const readyLength = this.pending.length - possibleMarkerLength;
      const ready = this.pending.slice(0, readyLength);
      if (this.pasting) this.pasteBuffer += ready;
      else output += ready;
      this.pending = this.pending.slice(readyLength);
      break;
    }

    callback(null, output);
  }

  _flush(callback) {
    // An unterminated paste (no PASTE_END before EOF): fold it inline.
    const remainder = this.pasting ? foldNewlines(this.pasteBuffer + this.pending) : this.pending;
    this.pasteBuffer = '';
    this.pending = '';
    this.pasting = false;
    callback(null, remainder);
  }

  finishPaste() {
    const content = this.pasteBuffer;
    this.pasteBuffer = '';
    if (this.shouldCollapse(content)) {
      return this.store.register(content).placeholder;
    }
    return foldNewlines(content);
  }

  shouldCollapse(content) {
    return content.includes('\n') || content.length > this.collapseChars;
  }
}

function foldNewlines(value) {
  return value.replace(/(?:\r\n|\r|\n)+/g, ' ');
}

function trailingMarkerPrefixLength(value, marker) {
  const maximum = Math.min(value.length, marker.length - 1);
  for (let length = maximum; length > 0; length -= 1) {
    if (value.endsWith(marker.slice(0, length))) return length;
  }
  return 0;
}

module.exports = { PASTE_END, PASTE_START, PasteInput, PasteStore, pasteLabel };
