'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

let codexLimitCache = { checkedAt: 0, value: null };

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

function sanitizeResetAt(value = '') {
  return String(value)
    .split(/",\s*"|","|\n/)[0]
    .replace(/["}]+$/, '')
    .trim()
    .slice(0, 120);
}

function sanitizeUsageEntry(entry = {}) {
  return {
    ...entry,
    resetAt: sanitizeResetAt(entry.resetAt),
    lastError: entry.lastError ? normalizeErrorMessage(entry.lastError) : ''
  };
}

function usageFor(state, provider) {
  return { ...blankUsage(), ...(state.usage?.[provider] || {}) };
}

function recordSuccess(state, provider, reported = {}) {
  state.usage ||= {};
  const current = usageFor(state, provider);
  const input = Number(reported.input_tokens ?? reported.inputTokens ?? 0) || 0;
  const output = Number(reported.output_tokens ?? reported.outputTokens ?? 0) || 0;
  const availability = current.manual
    ? { status: current.status, remainingPercent: current.remainingPercent, resetAt: current.resetAt }
    : { status: 'available', remainingPercent: null, resetAt: '' };
  state.usage[provider] = {
    ...current,
    ...availability,
    requests: current.requests + 1,
    inputTokens: current.inputTokens + input,
    outputTokens: current.outputTokens + output,
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
  if (usage.remainingPercent == null) return usage.status === 'available' ? 'available · limit hidden' : 'limit unavailable';
  const filled = Math.round((usage.remainingPercent / 100) * safeWidth);
  return `[${'█'.repeat(filled)}${'░'.repeat(safeWidth - filled)}] ${Math.round(usage.remainingPercent)}%`;
}

function parseCodexRateLimits(text) {
  const lines = String(text).split('\n');
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    try {
      const event = JSON.parse(lines[index]);
      const limits = event.payload?.rate_limits;
      if (!limits) continue;
      const windows = [limits.primary, limits.secondary].filter(Boolean).map(window => ({
        usedPercent: Number(window.used_percent) || 0,
        remainingPercent: Math.max(0, 100 - (Number(window.used_percent) || 0)),
        windowMinutes: Number(window.window_minutes) || 0,
        resetsAt: Number(window.resets_at) || 0
      }));
      if (!windows.length) continue;
      return { windows, planType: limits.plan_type || '', reachedType: limits.rate_limit_reached_type || '' };
    } catch { /* skip partial/non-JSON lines */ }
  }
  return null;
}

function latestJsonl(root) {
  let latest = null;
  function visit(directory, depth = 0) {
    if (depth > 5) return;
    let entries;
    try { entries = fs.readdirSync(directory, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(target, depth + 1);
      else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
        const mtime = fs.statSync(target).mtimeMs;
        if (!latest || mtime > latest.mtime) latest = { path: target, mtime };
      }
    }
  }
  visit(root);
  return latest?.path;
}

function readTail(file, bytes = 524288) {
  const size = fs.statSync(file).size;
  const length = Math.min(size, bytes);
  const buffer = Buffer.alloc(length);
  const descriptor = fs.openSync(file, 'r');
  try { fs.readSync(descriptor, buffer, 0, length, size - length); } finally { fs.closeSync(descriptor); }
  return buffer.toString('utf8');
}

function readCodexRateLimits() {
  if (Date.now() - codexLimitCache.checkedAt < 30000) return codexLimitCache.value;
  let value = null;
  try {
    const root = path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'sessions');
    const file = latestJsonl(root);
    if (file) value = parseCodexRateLimits(readTail(file));
  } catch { value = null; }
  codexLimitCache = { checkedAt: Date.now(), value };
  return value;
}

function refreshCodexLimit(state) {
  const limits = readCodexRateLimits();
  if (!limits) return null;
  state.usage ||= {};
  const current = usageFor(state, 'codex');
  if (current.manual) return current;
  const tightest = limits.windows.reduce((lowest, window) => window.remainingPercent < lowest.remainingPercent ? window : lowest);
  const resetAt = tightest.resetsAt ? new Date(tightest.resetsAt * 1000).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '';
  state.usage.codex = { ...current, remainingPercent: tightest.remainingPercent, status: tightest.remainingPercent === 0 ? 'exhausted' : 'ok', resetAt, limitWindows: limits.windows, planType: limits.planType, limitSource: 'codex-session' };
  return state.usage.codex;
}

module.exports = { blankUsage, detectLimitError, isLow, normalizeErrorMessage, parseCodexRateLimits, readCodexRateLimits, recordLimitError, recordSuccess, refreshCodexLimit, renderBar, sanitizeResetAt, sanitizeUsageEntry, score, setManualLimit, usageFor };
