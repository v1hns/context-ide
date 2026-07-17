'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { detectLimitError, isLow, normalizeErrorMessage, recordLimitError, recordSuccess, renderBar, sanitizeUsageEntry, setManualLimit, usageFor } = require('../usage');

test('detects exhausted quota and reset time from provider errors', () => {
  const signal = detectLimitError("You've hit your session limit · resets 5:30pm (America/Los_Angeles)");
  assert.equal(signal.status, 'exhausted');
  assert.equal(signal.remainingPercent, 0);
  assert.match(signal.resetAt, /5:30pm/);
});

test('extracts a clean limit message from Claude JSON errors', () => {
  const raw = JSON.stringify({ type: 'result', is_error: true, api_error_status: 429, result: "You've hit your session limit · resets 10:30pm (America/Los_Angeles)", stop_reason: 'stop_sequence', usage: { input_tokens: 0 } });
  assert.equal(normalizeErrorMessage(raw), "You've hit your session limit · resets 10:30pm (America/Los_Angeles)");
  const signal = detectLimitError(raw);
  assert.equal(signal.resetAt, '10:30pm (America/Los_Angeles)');
});

test('repairs reset text persisted by the older JSON parsing bug', () => {
  const dirty = '10:30pm (America/Los_Angeles)","stop_reason":"stop_sequence","session_id":"abc"}';
  const cleaned = sanitizeUsageEntry({ resetAt: dirty });
  assert.equal(cleaned.resetAt, '10:30pm (America/Los_Angeles)');
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
