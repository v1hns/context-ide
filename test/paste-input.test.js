'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { PASTE_END, PASTE_START, PasteInput, PasteStore } = require('../paste-input');

function transform(chunks, store) {
  return new Promise((resolve, reject) => {
    const input = new PasteInput(store ? { store } : {});
    let output = '';
    input.on('data', chunk => { output += chunk; });
    input.on('error', reject);
    input.on('end', () => resolve(output));
    for (const chunk of chunks) input.write(chunk);
    input.end();
  });
}

test('collapses a multi-line paste into a placeholder token', async () => {
  const store = new PasteStore();
  const result = await transform([`${PASTE_START}first\nsecond\r\nthird${PASTE_END}\n`], store);
  assert.equal(result, '[Pasted text #1 +3 lines]\n');
  assert.equal(store.get(1), 'first\nsecond\r\nthird');
});

test('expands a placeholder back to the original pasted text', async () => {
  const store = new PasteStore();
  await transform([`before ${PASTE_START}alpha\nbeta${PASTE_END} after\n`], store);
  const { text, expanded } = store.expand('before [Pasted text #1 +2 lines] after');
  assert.equal(text, 'before alpha\nbeta after');
  assert.equal(expanded.length, 1);
  assert.equal(expanded[0].lines, 2);
});

test('leaves a short single-line paste inline', async () => {
  const store = new PasteStore();
  const result = await transform([`${PASTE_START}quick note${PASTE_END}\n`], store);
  assert.equal(result, 'quick note\n');
  assert.equal(store.counter, 0);
});

test('collapses a long single-line paste by character count', async () => {
  const store = new PasteStore();
  const long = 'x'.repeat(250);
  const result = await transform([`${PASTE_START}${long}${PASTE_END}\n`], store);
  assert.equal(result, '[Pasted text #1 +250 chars]\n');
  assert.equal(store.get(1), long);
});

test('recognizes paste markers split between input chunks', async () => {
  const store = new PasteStore();
  const result = await transform(['before ', '\x1b[20', '0~one\ntwo', '\x1b[2', '01~', '\n'], store);
  assert.equal(result, 'before [Pasted text #1 +2 lines]\n');
  assert.equal(store.get(1), 'one\ntwo');
});

test('leaves ordinary typed newlines unchanged', async () => {
  assert.equal(await transform(['one\ntwo\n']), 'one\ntwo\n');
});

test('expand leaves unknown placeholders untouched', () => {
  const store = new PasteStore();
  const { text, expanded } = store.expand('keep [Pasted text #7 +3 lines] as-is');
  assert.equal(text, 'keep [Pasted text #7 +3 lines] as-is');
  assert.equal(expanded.length, 0);
});
