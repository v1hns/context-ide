'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { detectLimitError, isLow, recordLimitError, recordSuccess, renderBar, setManualLimit, usageFor } = require('../usage');

test('detects exhausted quota and reset time from provider errors', () => {
  const signal = detectLimitError("You've hit your session limit · resets 5:30pm (America/Los_Angeles)");
  assert.equal(signal.status, 'exhausted');
  assert.equal(signal.remainingPercent, 0);
  assert.match(signal.resetAt, /5:30pm/);
});

test('tracks measured usage without inventing a ceiling', () => {
  const state = {};
  recordSuccess(state, 'codex', { input_tokens: 120, output_tokens: 30 });
  const usage = usageFor(state, 'codex');
  assert.equal(usage.requests, 1);
  assert.equal(usage.inputTokens, 120);
  assert.equal(usage.remainingPercent, null);
  assert.match(renderBar(usage, 5), /\?{5}/);
});

test('manual remaining percentage controls low threshold', () => {
  const state = {};
  setManualLimit(state, 'kimi', 15, 'tomorrow');
  assert.equal(isLow(usageFor(state, 'kimi'), 20), true);
  assert.match(renderBar(usageFor(state, 'kimi'), 10), /15%/);
  setManualLimit(state, 'kimi', null);
  assert.equal(usageFor(state, 'kimi').manual, false);
});

test('manual limits are not overwritten by provider errors', () => {
  const state = {};
  setManualLimit(state, 'claude', 40);
  recordLimitError(state, 'claude', 'usage limit reached');
  assert.equal(usageFor(state, 'claude').remainingPercent, 40);
});
