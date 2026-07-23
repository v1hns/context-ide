'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { PromptBox } = require('../prompt-box');
const { PasteStore, PASTE_START, PASTE_END } = require('../paste-input');

// Build a box whose rendering is a no-op so we can exercise the editor logic
// without a real terminal.
function editor() {
  const store = new PasteStore();
  const input = { setRawMode() {}, resume() {}, setEncoding() {}, on() {}, off() {} };
  const output = { isTTY: true, rows: 24, columns: 80, write() { return true; }, on() {}, off() {} };
  const box = new PromptBox({ input, output, store });
  box.started = true;
  box._origOut = () => {};
  const lines = [];
  box.on('line', line => lines.push(line));
  return { box, store, lines };
}

test('types printable characters into the buffer', () => {
  const { box } = editor();
  box._feed('hello');
  assert.equal(box.buffer, 'hello');
  assert.equal(box.cursor, 5);
});

test('backspace deletes the character before the cursor', () => {
  const { box } = editor();
  box._feed('hello\x7f');
  assert.equal(box.buffer, 'hell');
  assert.equal(box.cursor, 4);
});

test('left arrow moves the cursor and inserts mid-line', () => {
  const { box } = editor();
  box._feed('hell');
  box._feed('\x1b[D\x1b[D'); // two lefts -> between "he" and "ll"
  box._feed('X');
  assert.equal(box.buffer, 'heXll');
});

test('enter emits the line and clears the buffer', () => {
  const { box, lines } = editor();
  box._feed('run tests\r');
  assert.deepEqual(lines, ['run tests']);
  assert.equal(box.buffer, '');
  assert.equal(box.cursor, 0);
});

test('a bracketed multi-line paste collapses to a placeholder', () => {
  const { box, store, lines } = editor();
  box._feed(`before ${PASTE_START}one\ntwo\nthree${PASTE_END} after\r`);
  assert.match(lines[0], /before \[Pasted text #1 \+3 lines\] after/);
  assert.equal(store.expand(lines[0]).text, 'before one\ntwo\nthree after');
});

test('paste markers split across feeds are still recognized', () => {
  const { box, lines } = editor();
  box._feed(`x\x1b[20`);
  box._feed(`0~a\nb\x1b[2`);
  box._feed(`01~\r`);
  assert.match(lines[0], /x\[Pasted text #1 \+2 lines\]/);
});

test('ctrl-u clears to the start of the line', () => {
  const { box } = editor();
  box._feed('delete me\x15');
  assert.equal(box.buffer, '');
});

test('up arrow recalls the previous submitted line', () => {
  const { box } = editor();
  box._feed('first\r');
  box._feed('\x1b[A');
  assert.equal(box.buffer, 'first');
});

test('stays editable while busy but cedes the status row to the spinner', () => {
  const writes = [];
  const input = { setRawMode() {}, resume() {}, setEncoding() {}, on() {}, off() {} };
  const output = { isTTY: true, rows: 24, columns: 80, write(s) { writes.push(String(s)); return true; }, on() {}, off() {} };
  const { PromptBox } = require('../prompt-box');
  const box = new PromptBox({ input, output });
  box.start();
  box.setStatus(['CTX-BAR']);
  box.pause(); // a turn is running
  writes.length = 0;
  box._feed('typed while busy');
  const out = writes.join('');
  assert.equal(box.buffer, 'typed while busy', 'keystrokes still register');
  assert.ok(out.includes('typed while busy'), 'input renders while busy');
  assert.ok(!out.includes('CTX-BAR'), 'status row is left to the spinner while busy');
  box.close();
});

test('resize clears the screen and repaints buffered output', () => {
  const writes = [];
  const input = { setRawMode() {}, resume() {}, setEncoding() {}, on() {}, off() {} };
  const output = { isTTY: true, rows: 24, columns: 80, write(s) { writes.push(String(s)); return true; }, on() {}, off() {} };
  const { PromptBox } = require('../prompt-box');
  const box = new PromptBox({ input, output });
  box.start();
  box._above('alpha\n');
  box._above('bravo\n');
  assert.deepEqual(box.scrollback, ['alpha', 'bravo']);
  writes.length = 0;
  box._resize();
  const out = writes.join('');
  assert.ok(out.includes('\x1b[2J'), 'clears the screen');
  assert.ok(out.includes('alpha') && out.includes('bravo'), 'repaints buffered lines');
  box.close();
});
