'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Footer, bar, clipVisible, visibleLength } = require('../ui');

test('bar renders a proportional meter clamped to [0,1]', () => {
  assert.equal(bar(0, 10), '░'.repeat(10));
  assert.equal(bar(1, 10), '█'.repeat(10));
  assert.equal(bar(0.5, 10), '█████░░░░░');
  assert.equal(bar(2, 4), '████');
  assert.equal(bar(-1, 4), '░░░░');
});

test('clipVisible respects width while preserving ANSI codes', () => {
  const colored = '\x1b[31mhello world\x1b[0m';
  const clipped = clipVisible(colored, 5);
  assert.equal(visibleLength(clipped), 5);
  assert.ok(clipped.includes('\x1b[31m'));
});

test('Footer is inert when stdout is not a TTY', () => {
  const writes = [];
  const fake = { isTTY: false, write: value => writes.push(value) };
  const footer = new Footer(fake);
  assert.equal(footer.enable(2), false);
  footer.set(['a', 'b']);
  assert.equal(footer.active, false);
  assert.equal(writes.length, 0);
});

test('Footer writes reserved rows when active', () => {
  const writes = [];
  const fake = { isTTY: true, rows: 24, columns: 80, write: value => writes.push(value), on() {}, removeListener() {} };
  const footer = new Footer(fake);
  assert.equal(footer.enable(2), true);
  writes.length = 0;
  footer.set(['top', 'bottom']);
  const output = writes.join('');
  assert.match(output, /top/);
  assert.match(output, /bottom/);
  assert.match(output, /\x1b\[23;1H/); // first reserved row (rows - height + 1)
});
