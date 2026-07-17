'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { buildPrompt, summaryCandidate } = require('../context');

function fixture() {
  const tab = {
    id: 'one', title: 'Private task', attachedIds: ['two'], summary: 'Earlier decision: use SQLite.', summaryThrough: 2,
    sessions: {}, messages: Array.from({ length: 30 }, (_, index) => ({
      role: index % 2 ? 'assistant' : 'user', content: `message-${index} ${'detail '.repeat(250)}`
    }))
  };
  const attached = { id: 'two', title: 'Research', attachedIds: [], summary: 'Attached secret summary', summaryThrough: 0, sessions: {}, messages: [{ role: 'user', content: 'attached secret message' }] };
  return {
    tab,
    state: {
      contextBudget: 4000, universalContext: `universal-secret ${'background '.repeat(5000)}`,
      privacy: {}, tabs: [tab, attached]
    }
  };
}

test('packs prompt within budget with headroom', () => {
  const { state, tab } = fixture();
  const packed = buildPrompt(state, tab, 'codex', 'complete the task');
  assert.ok(packed.estimatedTokens <= packed.budget);
  assert.match(packed.prompt, /truncated to context budget/);
});

test('provider privacy excludes disabled context sources', () => {
  const { state, tab } = fixture();
  state.privacy.codex = { universal: false, attached: false, history: false, native: false };
  const packed = buildPrompt(state, tab, 'codex', 'only this request');
  assert.doesNotMatch(packed.prompt, /universal-secret/);
  assert.doesNotMatch(packed.prompt, /attached secret/);
  assert.doesNotMatch(packed.prompt, /message-29/);
  assert.match(packed.prompt, /only this request/);
});

test('native session receives only cross-provider updates', () => {
  const { state, tab } = fixture();
  tab.sessions.codex = { id: 'session-id', syncedThrough: 28 };
  const packed = buildPrompt(state, tab, 'codex', 'continue');
  assert.doesNotMatch(packed.prompt, /message-27/);
  assert.match(packed.prompt, /message-28/);
  assert.match(packed.prompt, /message-29/);
});

test('selects older messages for rolling summarization', () => {
  const { tab } = fixture();
  const candidate = summaryCandidate(tab, 4000);
  assert.ok(candidate);
  assert.ok(candidate.through > tab.summaryThrough);
  assert.ok(candidate.through < tab.messages.length);
});
