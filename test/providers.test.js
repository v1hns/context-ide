'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseClaudeOutput } = require('../providers');

test('parses successful Claude JSON output', () => {
  const result = parseClaudeOutput(JSON.stringify({ result: 'hello', session_id: 'abc', usage: { input_tokens: 12 } }));
  assert.equal(result.answer, 'hello');
  assert.equal(result.sessionId, 'abc');
  assert.equal(result.usage.input_tokens, 12);
});

test('throws only Claude result text for structured API errors', () => {
  const raw = JSON.stringify({ is_error: true, api_error_status: 429, result: "You've hit your session limit · resets 10:30pm (America/Los_Angeles)", usage: {} });
  assert.throws(() => parseClaudeOutput(raw), error => {
    assert.equal(error.message, "You've hit your session limit · resets 10:30pm (America/Los_Angeles)");
    return true;
  });
});
