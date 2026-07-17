'use strict';

function blankUsage() {
  return { requests: 0, inputTokens: 0, outputTokens: 0, remainingPercent: null, status: 'unknown', resetAt: '', manual: false };
}

function normalizeErrorMessage(message = '') {
  const text = String(message);
  try {
    const parsed = JSON.parse(text);
    return String(parsed.result || parsed.error?.message || parsed.message || text);
  } catch { return text; }
}

function usageFor(state, provider) {
  return { ...blankUsage(), ...(state.usage?.[provider] || {}) };
}

function recordSuccess(state, provider, reported = {}) {
  state.usage ||= {};
  const current = usageFor(state, provider);
  const input = Number(reported.input_tokens ?? reported.inputTokens ?? 0) || 0;
  const output = Number(reported.output_tokens ?? reported.outputTokens ?? 0) || 0;
  state.usage[provider] = {
    ...current,
    requests: current.requests + 1,
    inputTokens: current.inputTokens + input,
    outputTokens: current.outputTokens + output,
    status: current.manual ? current.status : (current.remainingPercent == null ? 'unknown' : current.status),
    lastUsedAt: new Date().toISOString(),
    lastError: ''
  };
  return state.usage[provider];
}

function detectLimitError(message = '') {
  const text = normalizeErrorMessage(message);
  const exhausted = /(hit|reached|exceeded|exhausted).{0,30}(session|usage|rate|quota|limit)|session limit|billing cycle quota|HTTP\s*429/i.test(text);
  const low = exhausted || /rate.?limit|quota|capacity/i.test(text);
  if (!low) return null;
  const reset = text.match(/resets?(?:\s+at|\s+in)?\s+([^\n·]+)/i)?.[1]?.trim() || '';
  return { status: exhausted ? 'exhausted' : 'low', remainingPercent: exhausted ? 0 : null, resetAt: reset };
}

function recordLimitError(state, provider, message) {
  const signal = detectLimitError(message);
  if (!signal) return null;
  state.usage ||= {};
  const current = usageFor(state, provider);
  if (current.manual) return current;
  state.usage[provider] = { ...current, ...signal, lastError: normalizeErrorMessage(message), lastUsedAt: new Date().toISOString() };
  return state.usage[provider];
}

function setManualLimit(state, provider, percent, resetAt = '') {
  state.usage ||= {};
  const current = usageFor(state, provider);
  if (percent == null) {
    state.usage[provider] = { ...current, remainingPercent: null, status: 'unknown', resetAt: '', manual: false };
  } else {
    const value = Math.max(0, Math.min(100, Number(percent)));
    state.usage[provider] = { ...current, remainingPercent: value, status: value === 0 ? 'exhausted' : 'ok', resetAt, manual: true };
  }
  return state.usage[provider];
}

function isLow(usage, threshold) {
  return usage.status === 'exhausted' || usage.status === 'low' || (usage.remainingPercent != null && usage.remainingPercent <= threshold);
}

function score(usage) {
  if (usage.status === 'exhausted') return -1;
  if (usage.remainingPercent != null) return usage.remainingPercent;
  if (usage.status === 'low') return 5;
  return 50;
}

function renderBar(usage, width = 8) {
  const safeWidth = Math.max(4, Math.min(20, Number(width) || 8));
  if (usage.remainingPercent == null) return `[${'?'.repeat(safeWidth)}] ?`;
  const filled = Math.round((usage.remainingPercent / 100) * safeWidth);
  return `[${'█'.repeat(filled)}${'░'.repeat(safeWidth - filled)}] ${Math.round(usage.remainingPercent)}%`;
}

module.exports = { blankUsage, detectLimitError, isLow, normalizeErrorMessage, recordLimitError, recordSuccess, renderBar, score, setManualLimit, usageFor };
