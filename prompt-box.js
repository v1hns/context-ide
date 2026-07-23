'use strict';

// A pinned input box, the way Claude Code and Codex do it: the bottom of the
// terminal is a fixed, bordered text box you type into, and the conversation
// scrolls in the region above it. It owns raw-mode input and routes all program
// output above the box, so the box never moves or restacks.
//
// It exposes the small slice of the readline interface the CLI uses
// (on 'line'/'close'/'SIGINT', setPrompt, setTitle, setStatus, prompt, pause,
// resume, question, close) so it can stand in for readline on a TTY.

const EventEmitter = require('node:events');
const { PasteStore, PASTE_END, PASTE_START } = require('./paste-input');
const { clipVisible, visibleLength } = require('./ui');

const ESC = '\x1b';
const csi = code => `${ESC}[${code}`;
const C = { reset: '\x1b[0m', dim: '\x1b[2m', userGray: '\x1b[38;2;180;180;180m' };

function trailingMarkerPrefixLength(value, marker) {
  const maximum = Math.min(value.length, marker.length - 1);
  for (let length = maximum; length > 0; length -= 1) {
    if (value.endsWith(marker.slice(0, length))) return length;
  }
  return 0;
}

class PromptBox extends EventEmitter {
  constructor({ input = process.stdin, output = process.stdout, store, statusHeight = 1 } = {}) {
    super();
    this.input = input;
    this.output = output;
    this.store = store || new PasteStore();
    this.statusHeight = Math.max(1, statusHeight);
    this.promptText = '› ';
    this.titleText = '';
    this.statusLines = [];
    this.buffer = '';
    this.cursor = 0;
    this.history = [];
    this.historyIndex = -1;
    this.stash = '';
    this.busy = false;
    this.started = false;
    this.questionCb = null;
    this.pasting = false;
    this.pasteBuffer = '';
    this.pending = '';
    // Recent output lines, kept so we can repaint cleanly after a resize.
    this.scrollback = [];
    this._pendingLine = '';
    this._origOut = output.write.bind(output);
    this._origErr = (process.stderr.write || (() => {})).bind(process.stderr);
    this._onData = chunk => this._feed(chunk.toString('utf8'));
    // A drag-resize fires many events; coalesce them so the box repaints once,
    // after the size settles, instead of once per intermediate width.
    this._resizeTimer = null;
    this._onResize = () => { clearTimeout(this._resizeTimer); this._resizeTimer = setTimeout(() => this._resize(), 120); };
  }

  // ---- lifecycle ---------------------------------------------------------

  start() {
    if (this.started) return;
    this.started = true;
    this.input.setRawMode?.(true);
    this.input.resume();
    this.input.setEncoding('utf8');
    // Route every ordinary write above the box; the box draws with _origOut.
    this.output.write = (chunk, enc, cb) => { this._above(String(chunk)); if (typeof enc === 'function') enc(); else if (typeof cb === 'function') cb(); return true; };
    process.stderr.write = (chunk, enc, cb) => { this._above(String(chunk)); if (typeof enc === 'function') enc(); else if (typeof cb === 'function') cb(); return true; };
    this._origOut('\x1b[?2004h');
    this._applyRegion();
    this.input.on('data', this._onData);
    this.output.on('resize', this._onResize);
  }

  close() {
    if (!this.started) { this.emit('close'); return; }
    this.started = false;
    clearTimeout(this._resizeTimer);
    this.input.off('data', this._onData);
    this.output.off('resize', this._onResize);
    this.input.setRawMode?.(false);
    this.output.write = this._origOut;
    process.stderr.write = this._origErr;
    const g = this._geometry();
    let out = csi('r'); // release scroll region
    for (let row = g.topRow; row <= g.statusRow + this.statusHeight - 1; row += 1) out += csi(`${row};1H`) + csi('2K');
    out += csi(`${g.topRow};1H`) + '\x1b[?2004l';
    this._origOut(out);
    this.emit('close');
  }

  // "busy" means a turn is running: you can still type (the box stays live);
  // only the status row is ceded to the spinner. It never stops input.
  pause() { this.busy = true; }
  resume() { this.busy = false; if (this.started) this._render(); }

  // ---- configuration -----------------------------------------------------

  setPrompt(text) { this.promptText = text || '› '; }
  setTitle(text, color) { this.titleText = text || ''; this._titleColor = color || C.dim; }
  setStatus(lines) { this.statusLines = Array.isArray(lines) ? lines : [lines]; if (this.started) this._render(); }

  // Overwrite the status row directly, even while busy (used for the live
  // "cogitating" spinner during a turn). Leaves the input cursor untouched.
  setBusyLine(text) {
    if (!this.started) return;
    const g = this._geometry();
    this._origOut('\x1b7' + csi(`${g.statusRow};1H`) + csi('2K') + clipVisible(text, g.cols) + '\x1b8');
  }

  prompt() { if (this.started) this._render(); }

  question(query, callback) {
    this._above(query.endsWith('\n') ? query : `${query}\n`);
    this.questionCb = callback;
    this.buffer = '';
    this.cursor = 0;
    this._render();
  }

  // ---- geometry ----------------------------------------------------------

  _geometry() {
    const rows = this.output.rows || 24;
    const cols = this.output.columns || 80;
    const reserved = 3 + this.statusHeight;
    const scrollBottom = Math.max(1, rows - reserved);
    return { rows, cols, scrollBottom, topRow: scrollBottom + 1, inputRow: scrollBottom + 2, bottomRow: scrollBottom + 3, statusRow: scrollBottom + 4 };
  }

  _applyRegion() {
    const g = this._geometry();
    this._origOut(csi(`1;${g.scrollBottom}r`) + csi(`${g.scrollBottom};1H`));
    this._render();
  }

  _resize() {
    if (!this.started) return;
    const g = this._geometry();
    // The terminal's reflow smears the pinned box during a drag. On settle,
    // clear the screen and repaint the recent transcript (from our buffer)
    // bottom-aligned, then the box — so no stale frames survive.
    this._origOut(csi('r') + csi('2J') + csi(`1;${g.scrollBottom}r`) + csi(`${g.scrollBottom};1H`));
    for (const line of this.scrollback.slice(-g.scrollBottom)) this._writeRegion(`${line}\n`);
    this._render();
  }

  // ---- output above the box ---------------------------------------------

  // Print text into the scrolling region above the box, bottom-aligned. Each
  // trailing newline scrolls the region up, leaving the bottom row ready.
  _writeRegion(text) {
    const g = this._geometry();
    this._origOut('\x1b7' + csi(`${g.scrollBottom};1H`) + text.replace(/\r?\n/g, '\r\n') + '\x1b8');
  }

  _above(text) {
    if (!this.started) { this._origOut(text); return; }
    // Record complete logical lines so a resize can repaint them.
    const parts = (this._pendingLine + text).split('\n');
    this._pendingLine = parts.pop();
    for (const part of parts) {
      this.scrollback.push(part.replace(/\r$/, ''));
      if (this.scrollback.length > 2000) this.scrollback.splice(0, this.scrollback.length - 2000);
    }
    this._writeRegion(text);
  }

  // ---- rendering ---------------------------------------------------------

  _render() {
    if (!this.started) return;
    const g = this._geometry();
    const width = g.cols;
    const color = this._titleColor || C.dim;
    const title = this.titleText ? ` ${this.titleText} ` : '';
    const topFill = Math.max(1, width - 3 - visibleLength(title));
    const top = `${C.dim}╭─${C.reset}${color}${title}${C.reset}${C.dim}${'─'.repeat(topFill)}╮${C.reset}`;

    const gutter = `${C.dim}│${C.reset} ${this.promptText}`;
    const gutterWidth = visibleLength(gutter);
    const textWidth = Math.max(1, width - gutterWidth - 2); // room for trailing " │"
    let offset = 0;
    if (this.cursor > textWidth) offset = this.cursor - textWidth;
    const shown = this.buffer.slice(offset, offset + textWidth);
    const pad = ' '.repeat(Math.max(0, textWidth - shown.length));
    const input = `${gutter}${shown}${pad} ${C.dim}│${C.reset}`;

    const bottom = `${C.dim}╰${'─'.repeat(Math.max(1, width - 2))}╯${C.reset}`;

    let out = csi(`${g.topRow};1H`) + csi('2K') + clipVisible(top, width);
    out += csi(`${g.inputRow};1H`) + csi('2K') + input;
    out += csi(`${g.bottomRow};1H`) + csi('2K') + clipVisible(bottom, width);
    // While a turn runs, the spinner owns the status row — don't overwrite it.
    if (!this.busy) {
      for (let i = 0; i < this.statusHeight; i += 1) {
        out += csi(`${g.statusRow + i};1H`) + csi('2K') + clipVisible(this.statusLines[i] || '', width);
      }
    }
    // Place the hardware cursor at the edit position inside the box.
    const cursorCol = gutterWidth + 1 + (this.cursor - offset);
    out += csi(`${g.inputRow};${cursorCol}H`);
    this._origOut(out);
  }

  // Redraw ONLY the input row. Called on every keystroke — the borders and
  // status don't change while typing, so repainting them (≈960 bytes) per key
  // is what made typing lag. This writes ≈1 line instead.
  _renderInput() {
    if (!this.started) return;
    const g = this._geometry();
    const width = g.cols;
    const gutter = `${C.dim}│${C.reset} ${this.promptText}`;
    const gutterWidth = visibleLength(gutter);
    const textWidth = Math.max(1, width - gutterWidth - 2);
    let offset = 0;
    if (this.cursor > textWidth) offset = this.cursor - textWidth;
    const shown = this.buffer.slice(offset, offset + textWidth);
    const cursorCol = gutterWidth + 1 + (this.cursor - offset);
    this._origOut(
      csi(`${g.inputRow};1H`) + csi('2K') + gutter + shown +
      csi(`${g.inputRow};${width}H`) + `${C.dim}│${C.reset}` +
      csi(`${g.inputRow};${cursorCol}H`)
    );
  }

  // ---- input parsing -----------------------------------------------------

  _feed(chunk) {
    this.pending += chunk;
    while (this.pending.length) {
      if (this.pasting) {
        const end = this.pending.indexOf(PASTE_END);
        if (end === -1) {
          const keep = trailingMarkerPrefixLength(this.pending, PASTE_END);
          this.pasteBuffer += this.pending.slice(0, this.pending.length - keep);
          this.pending = this.pending.slice(this.pending.length - keep);
          return;
        }
        this.pasteBuffer += this.pending.slice(0, end);
        this.pending = this.pending.slice(end + PASTE_END.length);
        this.pasting = false;
        this._commitPaste();
        continue;
      }
      const start = this.pending.indexOf(PASTE_START);
      if (start === 0) { this.pasting = true; this.pending = this.pending.slice(PASTE_START.length); continue; }
      const boundary = start === -1 ? this.pending.length : start;
      // Leave a possible partial paste-start marker in the buffer for next chunk.
      const partial = start === -1 ? trailingMarkerPrefixLength(this.pending, PASTE_START) : 0;
      const consumable = boundary - partial;
      if (consumable <= 0) return;
      const consumed = this._consumeKeys(this.pending.slice(0, consumable));
      this.pending = this.pending.slice(consumed);
      if (consumed === 0) return; // waiting for the rest of an escape sequence
    }
  }

  _commitPaste() {
    const content = this.pasteBuffer;
    this.pasteBuffer = '';
    if (content.includes('\n') || content.length > 200) {
      const { placeholder } = this.store.register(content);
      this._insert(placeholder);
    } else {
      this._insert(content.replace(/\s+/g, ' '));
    }
  }

  // Process a run of bytes with no paste markers. Returns how many were used
  // (may stop short if the tail is an incomplete escape sequence).
  _consumeKeys(data) {
    let i = 0;
    while (i < data.length) {
      const ch = data[i];
      if (ch === '\x1b') {
        const seq = data.slice(i);
        const match = seq.match(/^\x1b\[[0-9;]*[A-Za-z~]|^\x1bO[A-Za-z]/);
        if (!match) {
          // Possibly an incomplete sequence at the very end of the chunk.
          if (seq.length <= 6 && i + seq.length === data.length) return i;
          i += 1; continue; // lone ESC, skip
        }
        this._handleEscape(match[0]);
        i += match[0].length;
        continue;
      }
      if (ch === '\r' || ch === '\n') { this._submit(); i += 1; continue; }
      if (ch === '\x7f' || ch === '\x08') { this._backspace(); i += 1; continue; }
      if (ch === '\x03') { this.emit('SIGINT'); i += 1; continue; }
      if (ch === '\x04') { if (!this.buffer) this.close(); i += 1; continue; }
      if (ch === '\x15') { this.buffer = this.buffer.slice(this.cursor); this.cursor = 0; this._renderInput(); i += 1; continue; }
      if (ch === '\x01') { this.cursor = 0; this._renderInput(); i += 1; continue; }
      if (ch === '\x05') { this.cursor = this.buffer.length; this._renderInput(); i += 1; continue; }
      if (ch === '\x17') { this._deleteWord(); i += 1; continue; }
      if (ch < ' ') { i += 1; continue; } // ignore other control chars
      // Printable run (fast path for typed/pasted text).
      let j = i;
      while (j < data.length && data[j] >= ' ' && data[j] !== '\x7f') j += 1;
      this._insert(data.slice(i, j));
      i = j;
    }
    return i;
  }

  _handleEscape(seq) {
    switch (seq) {
      case '\x1b[D': case '\x1bOD': if (this.cursor > 0) { this.cursor -= 1; this._renderInput(); } break;
      case '\x1b[C': case '\x1bOC': if (this.cursor < this.buffer.length) { this.cursor += 1; this._renderInput(); } break;
      case '\x1b[A': case '\x1bOA': this._history(-1); break;
      case '\x1b[B': case '\x1bOB': this._history(1); break;
      case '\x1b[H': case '\x1b[1~': case '\x1bOH': this.cursor = 0; this._renderInput(); break;
      case '\x1b[F': case '\x1b[4~': case '\x1bOF': this.cursor = this.buffer.length; this._renderInput(); break;
      case '\x1b[3~': if (this.cursor < this.buffer.length) { this.buffer = this.buffer.slice(0, this.cursor) + this.buffer.slice(this.cursor + 1); this._renderInput(); } break;
      default: break;
    }
  }

  // ---- editing primitives ------------------------------------------------

  _insert(text) {
    if (!text) return;
    this.buffer = this.buffer.slice(0, this.cursor) + text + this.buffer.slice(this.cursor);
    this.cursor += text.length;
    this.historyIndex = -1;
    this._renderInput();
  }

  _backspace() {
    if (this.cursor === 0) return;
    this.buffer = this.buffer.slice(0, this.cursor - 1) + this.buffer.slice(this.cursor);
    this.cursor -= 1;
    this._renderInput();
  }

  _deleteWord() {
    if (this.cursor === 0) return;
    let start = this.cursor;
    while (start > 0 && this.buffer[start - 1] === ' ') start -= 1;
    while (start > 0 && this.buffer[start - 1] !== ' ') start -= 1;
    this.buffer = this.buffer.slice(0, start) + this.buffer.slice(this.cursor);
    this.cursor = start;
    this._renderInput();
  }

  _history(direction) {
    if (!this.history.length) return;
    if (this.historyIndex === -1) {
      if (direction > 0) return;
      this.stash = this.buffer;
      this.historyIndex = this.history.length - 1;
    } else {
      this.historyIndex += direction;
    }
    if (this.historyIndex >= this.history.length) { this.historyIndex = -1; this.buffer = this.stash; }
    else if (this.historyIndex < 0) { this.historyIndex = 0; }
    if (this.historyIndex !== -1) this.buffer = this.history[this.historyIndex];
    this.cursor = this.buffer.length;
    this._renderInput();
  }

  _submit() {
    const line = this.buffer;
    this.buffer = '';
    this.cursor = 0;
    this.historyIndex = -1;
    if (this.questionCb) {
      const cb = this.questionCb;
      this.questionCb = null;
      this._render();
      cb(line);
      return;
    }
    if (line.trim()) this.history.push(line);
    // Echo the submitted line into the transcript above the box, in a lighter
    // gray so past user messages are easy to pick out from model output.
    const { text } = this.store.expand(line);
    const echoLines = (text || '').split('\n');
    this._above(`${C.dim}›${C.reset} ${C.userGray}${echoLines[0]}${C.reset}${echoLines.length > 1 ? `${C.dim} … (+${echoLines.length - 1} lines)${C.reset}` : ''}\n`);
    this._render();
    this.emit('line', line);
  }
}

module.exports = { PromptBox };
