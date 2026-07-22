'use strict';

// A pinned status footer. It reserves the bottom rows of the terminal with a
// DEC scroll region so conversation output scrolls above while the context and
// limit bars stay permanently visible below the prompt. Everything degrades to
// a no-op when stdout is not a TTY, so non-interactive use is unaffected.

const ESC = '\x1b';
const csi = code => `${ESC}[${code}`;

const STRIP_ANSI = /\x1b\[[0-9;?]*[A-Za-z]/g;

function visibleLength(text) {
  return String(text).replace(STRIP_ANSI, '').length;
}

// Clip a string that may contain ANSI colour codes to a visible column width
// without cutting an escape sequence in half.
function clipVisible(text, width) {
  if (width <= 0) return '';
  let out = '';
  let shown = 0;
  const value = String(text);
  for (let i = 0; i < value.length; i += 1) {
    if (value[i] === '\x1b') {
      const match = value.slice(i).match(/^\x1b\[[0-9;?]*[A-Za-z]/);
      if (match) { out += match[0]; i += match[0].length - 1; continue; }
    }
    if (shown >= width) break;
    out += value[i];
    shown += 1;
  }
  return out;
}

// A compact unicode meter, e.g. bar(0.42, 10) -> "████░░░░░░". Clamps to [0,1].
function bar(fraction, width = 10) {
  const safeWidth = Math.max(1, Math.floor(width));
  const clamped = Math.max(0, Math.min(1, Number(fraction) || 0));
  const filled = Math.round(clamped * safeWidth);
  return '█'.repeat(filled) + '░'.repeat(safeWidth - filled);
}

class Footer {
  constructor(out = process.stdout) {
    this.out = out;
    this.lines = [];
    this.height = 0;
    this.enabled = false;
    this.onResize = null;
    this._resizeHandler = () => this.handleResize();
  }

  get active() {
    return this.enabled && Boolean(this.out.isTTY);
  }

  get columns() {
    return this.out.columns || 80;
  }

  get rows() {
    return this.out.rows || 24;
  }

  enable(height) {
    if (!this.out.isTTY) return false;
    this.height = Math.max(1, height);
    this.enabled = true;
    this.applyRegion();
    this.out.on('resize', this._resizeHandler);
    return true;
  }

  // Reserve the bottom `height` rows and drop the cursor to the bottom of the
  // scrolling region so subsequent output bottom-aligns against the footer.
  applyRegion() {
    if (!this.active) return;
    const bottom = Math.max(1, this.rows - this.height);
    this.out.write(csi(`1;${bottom}r`) + csi(`${bottom};1H`));
  }

  handleResize() {
    if (!this.active) return;
    this.applyRegion();
    this.render();
    if (this.onResize) this.onResize();
  }

  set(lines) {
    this.lines = Array.isArray(lines) ? lines : [lines];
    this.render();
  }

  render() {
    if (!this.active) return;
    const start = this.rows - this.height + 1;
    let buffer = ESC + '7'; // save cursor + attributes
    for (let i = 0; i < this.height; i += 1) {
      const row = start + i;
      const text = clipVisible(this.lines[i] || '', this.columns);
      buffer += csi(`${row};1H`) + csi('2K') + text;
    }
    buffer += ESC + '8'; // restore cursor + attributes
    this.out.write(buffer);
  }

  disable() {
    if (!this.out.isTTY) return;
    this.enabled = false;
    this.out.removeListener('resize', this._resizeHandler);
    // Clear the reserved rows, then release the scroll region.
    const start = this.rows - this.height + 1;
    let buffer = ESC + '7';
    for (let i = 0; i < this.height; i += 1) buffer += csi(`${start + i};1H`) + csi('2K');
    buffer += ESC + '8' + csi('r');
    this.out.write(buffer);
  }
}

module.exports = { Footer, bar, clipVisible, visibleLength };
