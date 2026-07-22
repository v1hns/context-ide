'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseClaudeOutput, buildRegistry, normalizeCustom, providerAvailable } = require('../providers');

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

test('buildRegistry merges built-ins with normalized custom providers', () => {
  const registry = buildRegistry([{ name: 'moonshot', type: 'openai', baseUrl: 'https://api.moonshot.ai/v1/', model: 'kimi-k2', apiKeyEnv: 'MOONSHOT_API_KEY' }]);
  assert.ok(registry.codex);
  assert.equal(registry.moonshot.custom, true);
  assert.equal(registry.moonshot.baseUrl, 'https://api.moonshot.ai/v1');
  assert.equal(registry.moonshot.nativeSessions, false);
});

test('normalizeCustom fills defaults for a generic CLI provider', () => {
  const def = normalizeCustom({ name: 'grok', type: 'cli', command: 'grok' });
  assert.equal(def.type, 'cli-template');
  assert.deepEqual(def.args, ['-p', '{prompt}']);
});

test('providerAvailable checks env for API providers', () => {
  const def = normalizeCustom({ name: 'x', type: 'openai', apiKeyEnv: 'CTXIDE_TEST_KEY' });
  delete process.env.CTXIDE_TEST_KEY;
  assert.equal(providerAvailable(def), false);
  process.env.CTXIDE_TEST_KEY = 'sk-test';
  assert.equal(providerAvailable(def), true);
  delete process.env.CTXIDE_TEST_KEY;
});
