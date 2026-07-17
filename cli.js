#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const readline = require('node:readline');
const { spawn } = require('node:child_process');
const { DEFAULT_BUDGET, buildPrompt, defaultPrivacy, estimateTokens, privacyFor, summaryCandidate, summaryPrompt } = require('./context');
const { PROVIDERS, commandExists, run, runProvider } = require('./providers');
const { detectLimitError, isLow, recordLimitError, recordSuccess, refreshCodexLimit, renderBar, sanitizeUsageEntry, score, setManualLimit, usageFor } = require('./usage');

const DATA_DIR = path.join(os.homedir(), '.context-ide');
const STATE_FILE = path.join(DATA_DIR, 'workspace.json');
const LEGACY_TITLE = 'Build the context layer';
const LEGACY_CONTEXT = 'Project: Context IDE\nKeep durable decisions here so agent switches do not lose them.';
const C = {
  reset: '\x1b[0m', bold: '\x1b[1m', dim: '\x1b[2m',
  cyan: '\x1b[36m', violet: '\x1b[35m', green: '\x1b[32m', red: '\x1b[31m', yellow: '\x1b[33m'
};

const defaults = () => ({
  version: 4,
  contextBudget: DEFAULT_BUDGET,
  settings: { statusBar: true, delegation: true, ping: true, lowThreshold: 20, barWidth: 7 },
  usage: {},
  privacy: Object.fromEntries(Object.keys(PROVIDERS).map(name => [name, defaultPrivacy()])),
  universalContext: '',
  activeTabId: 'welcome',
  tabs: [{ id: 'welcome', title: 'General', cwd: process.cwd(), provider: 'codex', attachedIds: [], messages: [], summary: '', summaryThrough: 0, sessions: {} }]
});

function migrate(raw) {
  const base = defaults();
  const cleanUsage = Object.fromEntries(Object.entries(raw.usage || {}).map(([provider, usage]) => [provider, sanitizeUsageEntry(usage)]));
  const migrated = { ...base, ...raw, version: 4, settings: { ...base.settings, ...(raw.settings || {}) }, usage: cleanUsage, privacy: { ...base.privacy, ...(raw.privacy || {}) } };
  const legacyWelcome = raw.tabs.some(tab => tab.id === 'welcome' && tab.title === LEGACY_TITLE);
  if (legacyWelcome && migrated.universalContext === LEGACY_CONTEXT) migrated.universalContext = '';
  migrated.tabs = raw.tabs.map(tab => {
    const next = { cwd: process.cwd(), summary: '', summaryThrough: 0, sessions: {}, ...tab };
    if (tab.id === 'welcome' && tab.title === LEGACY_TITLE) return { ...next, title: 'General', messages: [], summary: '', summaryThrough: 0, sessions: {} };
    return next;
  });
  return migrated;
}

function load() {
  try {
    const state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    if (!Array.isArray(state.tabs) || !state.tabs.length) throw new Error('Invalid workspace');
    return migrate(state);
  } catch { return defaults(); }
}

let state = load();
let busy = false;
let restarting = false;
const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });

function save() {
  fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
  fs.writeFileSync(STATE_FILE, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
}

function activeTab() {
  return state.tabs.find(tab => tab.id === state.activeTabId) || state.tabs[0];
}

function id() { return `task-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`; }
function providerColor(provider) { return provider === 'claude' ? C.violet : C.cyan; }
function promptLabel() {
  const tab = activeTab();
  return `${providerColor(tab.provider)}${tab.provider}${C.reset} ${C.dim}[${tab.title}]${C.reset} › `;
}
function usedProviders() {
  return [...new Set([...state.tabs.map(tab => tab.provider), ...Object.keys(state.usage || {})])].filter(name => PROVIDERS[name]);
}
function statusBar() {
  if (!state.settings.statusBar) return;
  refreshCodexLimit(state);
  const parts = usedProviders().map(name => {
    const usage = usageFor(state, name);
    const color = usage.status === 'unknown' ? C.dim : usage.status === 'exhausted' ? C.red : isLow(usage, state.settings.lowThreshold) ? C.yellow : C.green;
    if (usage.status === 'exhausted') return `${color}${name}: blocked${usage.resetAt ? ` until ${usage.resetAt}` : ''}${C.reset}`;
    if (usage.remainingPercent != null) return `${color}${name}: ${renderBar(usage, state.settings.barWidth).replace('%', '% left')}${C.reset}`;
    return `${color}${name}: ${usage.status === 'available' ? 'ready (quota not exposed)' : 'quota unavailable'}${C.reset}`;
  });
  if (parts.length) console.log(`${C.dim}models${C.reset}  ${parts.join('  │  ')}`);
}
function prompt() {
  if (busy) return;
  statusBar();
  rl.setPrompt(promptLabel());
  rl.prompt();
}

function banner() {
  console.log(`${C.bold}Context IDE${C.reset}  ${C.dim}multi-agent subscription + local workspace${C.reset}`);
  console.log(`${C.dim}Type /help for commands. Your workspace is saved locally.${C.reset}\n`);
  status();
}

function status() {
  const tab = activeTab();
  const attached = (tab.attachedIds || []).map(tid => state.tabs.find(t => t.id === tid)?.title).filter(Boolean);
  console.log(`${C.bold}${tab.title}${C.reset} · ${providerColor(tab.provider)}${tab.provider}${C.reset} · ${tab.messages.length} messages`);
  console.log(`${C.dim}Working directory: ${tab.cwd}${C.reset}`);
  if (attached.length) console.log(`${C.dim}Attached: ${attached.join(', ')}${C.reset}`);
  console.log(`${C.dim}Local history: ~${estimateTokens(tab.messages.map(message => message.content).join('\n'))} tokens · budget: ${state.contextBudget} · summarized: ${tab.summaryThrough || 0}/${tab.messages.length}${C.reset}`);
}

function privacyStatus(providerName = activeTab().provider) {
  const policy = privacyFor(state, providerName);
  console.log(`${C.bold}${providerName} privacy${C.reset}`);
  Object.entries(policy).forEach(([key, value]) => console.log(`  ${value ? C.green + 'on ' : C.yellow + 'off'}${C.reset} ${key}`));
}

function sessionsStatus(tab = activeTab()) {
  const entries = Object.entries(tab.sessions || {});
  if (!entries.length) return console.log(`${C.dim}No native sessions for this task.${C.reset}`);
  entries.forEach(([provider, session]) => console.log(`${provider.padEnd(9)} ${session.id} ${C.dim}synced through message ${session.syncedThrough || 0}${C.reset}`));
}

function configStatus() {
  console.log(`${C.bold}Interface settings${C.reset}`);
  Object.entries(state.settings).forEach(([key, value]) => console.log(`  ${key.padEnd(14)} ${value}`));
}

function usageStatus() {
  refreshCodexLimit(state);
  usedProviders().forEach(name => {
    const usage = usageFor(state, name);
    console.log(`${C.bold}${name}${C.reset} ${renderBar(usage, state.settings.barWidth)} · ${usage.requests} calls · ${usage.inputTokens + usage.outputTokens} measured tokens${usage.resetAt ? ` · resets ${usage.resetAt}` : ''}${usage.manual ? ' · manual limit' : ''}`);
    for (const window of usage.limitWindows || []) {
      const label = window.windowMinutes >= 10080 ? `${Math.round(window.windowMinutes / 10080)}w` : window.windowMinutes >= 1440 ? `${Math.round(window.windowMinutes / 1440)}d` : `${Math.round(window.windowMinutes / 60)}h`;
      const reset = window.resetsAt ? new Date(window.resetsAt * 1000).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : 'unknown';
      console.log(`${C.dim}  ${label} window: ${window.remainingPercent}% remaining · resets ${reset}${C.reset}`);
    }
  });
}

function listTabs() {
  state.tabs.forEach((tab, index) => {
    const marker = tab.id === state.activeTabId ? `${C.green}●${C.reset}` : '○';
    console.log(`${marker} ${index + 1}. ${tab.title} ${C.dim}(${tab.provider}, ${tab.messages.length} messages)${C.reset}`);
  });
}

function tabAt(value) {
  const index = Number(value) - 1;
  return Number.isInteger(index) ? state.tabs[index] : undefined;
}

async function updateSummary(tab, providerName, force = false) {
  const policy = privacyFor(state, providerName);
  if (!policy.history) return false;
  const candidate = summaryCandidate(tab, state.contextBudget, force);
  if (!candidate) return false;
  console.log(`${C.dim}Compressing older context into a rolling summary…${C.reset}`);
  try {
    const result = await runProvider(providerName, summaryPrompt(tab, candidate), { ephemeral: true, cwd: tab.cwd });
    if (!result.answer) return false;
    recordSuccess(state, providerName, result.usage);
    tab.summary = result.answer;
    tab.summaryThrough = candidate.through;
    save();
    return true;
  } catch (error) {
    recordLimitError(state, providerName, error.message);
    console.log(`${C.yellow}Summary skipped: ${error.message}${C.reset}`);
    return false;
  }
}

function delegationTarget(from) {
  return Object.keys(PROVIDERS)
    .filter(name => name !== from && commandExists(PROVIDERS[name].command) && !isLow(usageFor(state, name), state.settings.lowThreshold))
    .sort((a, b) => score(usageFor(state, b)) - score(usageFor(state, a)))[0];
}

function requestDelegation(from, reason) {
  const target = delegationTarget(from);
  if (!state.settings.delegation || !target) return Promise.resolve(null);
  if (state.settings.ping) process.stdout.write('\x07');
  const detail = reason ? ` (${reason})` : '';
  return new Promise(resolve => {
    rl.question(`${C.yellow}${from} is low${detail}.${C.reset} Delegate this request to ${C.bold}${target}${C.reset}? [Y/n] `, answer => {
      resolve(/^n(?:o)?$/i.test(answer.trim()) ? null : target);
    });
  });
}

async function askAgent(text, options = {}) {
  const tab = activeTab();
  const providerName = tab.provider;
  const provider = PROVIDERS[providerName];
  if (!provider) {
    console.error(`${C.red}Unknown provider: ${providerName}${C.reset}`);
    return prompt();
  }
  if (!commandExists(provider.command)) {
    console.error(`${C.red}${providerName} is not installed.${C.reset}\n${C.dim}${provider.setup}${C.reset}\n`);
    return prompt();
  }
  const currentUsage = usageFor(state, providerName);
  if (!options.skipPreflight && isLow(currentUsage, state.settings.lowThreshold)) {
    const target = await requestDelegation(providerName, currentUsage.resetAt ? `resets ${currentUsage.resetAt}` : currentUsage.status);
    if (target) {
      tab.provider = target;
      save();
      return askAgent(text, { skipPreflight: true });
    }
  }
  busy = true;
  rl.pause();
  console.log(`${C.dim}${providerName} is working…${C.reset}`);
  let limitFailure;
  try {
    await updateSummary(tab, providerName);
    const packed = buildPrompt(state, tab, providerName, text);
    const policy = packed.policy;
    const nativeCapable = provider.nativeSessions && policy.native;
    const session = nativeCapable ? tab.sessions[providerName] : undefined;
    let result;
    try {
      result = await runProvider(providerName, packed.prompt, { sessionId: session?.id, cwd: tab.cwd });
    } catch (error) {
      if (!session?.id || detectLimitError(error.message)) throw error;
      console.log(`${C.yellow}Native session unavailable; rebuilding it from portable context.${C.reset}`);
      delete tab.sessions[providerName];
      result = await runProvider(providerName, buildPrompt(state, tab, providerName, text).prompt, { cwd: tab.cwd });
    }
    tab.messages.push({ role: 'user', content: text });
    const content = result.answer || '(No response)';
    tab.messages.push({ role: 'assistant', provider: providerName, content });
    if (nativeCapable && result.sessionId) {
      tab.sessions[providerName] = { id: result.sessionId, syncedThrough: tab.messages.length, updatedAt: new Date().toISOString() };
    }
    recordSuccess(state, providerName, result.usage);
    console.log(`\n${providerColor(providerName)}${C.bold}${providerName}${C.reset}\n${content}\n`);
    console.log(`${C.dim}Context: ~${packed.estimatedTokens}/${packed.budget} tokens${nativeCapable ? ' · native session on' : ''}${C.reset}`);
  } catch (error) {
    limitFailure = recordLimitError(state, providerName, error.message);
    console.error(`${C.red}Could not run ${providerName}: ${error.message}${C.reset}\n`);
  } finally {
    busy = false;
    rl.resume();
    save();
  }
  if (limitFailure) {
    const target = await requestDelegation(providerName, limitFailure.resetAt ? `resets ${limitFailure.resetAt}` : limitFailure.status);
    if (target) {
      tab.provider = target;
      save();
      return askAgent(text, { skipPreflight: true });
    }
  }
  prompt();
}

async function gitCommand(input) {
  const [subcommand, ...words] = input.split(/\s+/).filter(Boolean);
  let args;
  switch (subcommand) {
    case 'status': args = ['status', '--short', '--branch']; break;
    case 'diff': args = ['diff']; break;
    case 'log': args = ['log', '-10', '--oneline', '--decorate']; break;
    case 'remotes': args = ['remote', '-v']; break;
    case 'add': args = ['add', '-A']; break;
    case 'commit':
      if (!words.length) {
        console.log(`${C.yellow}Usage: /git commit <message>${C.reset}`);
        return prompt();
      }
      args = ['commit', '-m', words.join(' ')];
      break;
    case 'push': args = ['push']; break;
    default:
      console.log(`${C.yellow}Choose: status, diff, log, remotes, add, commit <message>, push${C.reset}`);
      return prompt();
  }
  busy = true;
  rl.pause();
  try {
    const output = await run('git', args, '', activeTab().cwd);
    console.log(`${output.stdout || output.stderr || C.green + 'Done.' + C.reset}\n`);
  } catch (error) {
    console.error(`${C.red}Git failed: ${error.message}${C.reset}\n`);
  } finally {
    busy = false;
    rl.resume();
    prompt();
  }
}

function help() {
  console.log(`
${C.bold}Conversation${C.reset}
  /agent <provider>     switch the active task's CLI agent
  /providers            show providers, availability, and setup
  /usage                show measured usage and known limits
  /limit <provider> <0-100|auto> [reset time]
  /config               show customizable interface settings
  /config statusbar|delegation|ping <on|off>
  /config threshold <1-99>
  /config barwidth <4-20>
  /budget [tokens]      show or set the prompt context budget
  /summary              show the rolling summary
  /summary now          summarize older context now
  /privacy [provider]   show a provider's sharing policy
  /privacy <provider> <universal|attached|history|native> <on|off>
  /sessions             show native provider sessions
  /sessions reset [provider]  forget native session(s)
  /clear                clear this task's conversation
  /status               show active task details

${C.bold}Tasks${C.reset}
  /new <title>          create a task
  /tabs                 list tasks
  /switch <number>      switch task
  /rename <title>       rename active task
  /cd <path>            set this task's working directory
  /attach <number>      attach another task's context
  /detach <number>      detach a task

${C.bold}Shared context${C.reset}
  /context              show universal context
  /context set <text>   replace universal context
  /context add <text>   append universal context

${C.bold}GitHub workflow${C.reset}
  /git status           show repository status
  /git diff             show unstaged changes
  /git log              show recent commits
  /git remotes          show GitHub remotes
  /git add              stage all workspace changes
  /git commit <message> commit staged changes
  /git push             push to the tracked remote

  /restart              save and restart Context IDE
  /exit                 save and quit
`);
}

function command(line) {
  const [name, ...parts] = line.slice(1).trim().split(/\s+/);
  const rest = parts.join(' ').trim();
  const tab = activeTab();
  switch ((name || '').toLowerCase()) {
    case 'help': help(); break;
    case 'status': status(); break;
    case 'tabs': listTabs(); break;
    case 'providers':
      Object.entries(PROVIDERS).forEach(([key, provider]) => {
        const ready = commandExists(provider.command);
        console.log(`${ready ? C.green + '● ready' : C.yellow + '○ setup'}${C.reset}  ${key.padEnd(9)} ${C.dim}${ready ? provider.command : provider.setup}${C.reset}`);
      });
      break;
    case 'usage': usageStatus(); break;
    case 'limit': {
      const [providerName, value, ...resetWords] = rest.split(/\s+/);
      if (!PROVIDERS[providerName] || !value) {
        console.log(`${C.yellow}Usage: /limit <provider> <0-100|auto> [reset time]${C.reset}`);
      } else if (value === 'auto') {
        setManualLimit(state, providerName, null); save(); usageStatus();
      } else {
        const percent = Number(value);
        if (!Number.isFinite(percent) || percent < 0 || percent > 100) console.log(`${C.yellow}Remaining percent must be 0 through 100.${C.reset}`);
        else { setManualLimit(state, providerName, percent, resetWords.join(' ')); save(); usageStatus(); }
      }
      break;
    }
    case 'config': {
      if (!rest) { configStatus(); break; }
      const [key, value] = rest.split(/\s+/);
      const booleanKeys = { statusbar: 'statusBar', delegation: 'delegation', ping: 'ping' };
      if (booleanKeys[key] && ['on', 'off'].includes(value)) state.settings[booleanKeys[key]] = value === 'on';
      else if (key === 'threshold' && Number.isInteger(Number(value)) && Number(value) >= 1 && Number(value) <= 99) state.settings.lowThreshold = Number(value);
      else if (key === 'barwidth' && Number.isInteger(Number(value)) && Number(value) >= 4 && Number(value) <= 20) state.settings.barWidth = Number(value);
      else { console.log(`${C.yellow}Usage: /config statusbar|delegation|ping on|off, /config threshold 1-99, or /config barwidth 4-20${C.reset}`); break; }
      save(); configStatus(); break;
    }
    case 'budget': {
      if (!rest) console.log(`${C.bold}Context budget:${C.reset} ${state.contextBudget} estimated input tokens`);
      else {
        const value = Number(rest);
        if (!Number.isInteger(value) || value < 4000 || value > 48000) console.log(`${C.yellow}Choose a budget from 4000 to 48000 tokens.${C.reset}`);
        else { state.contextBudget = value; save(); console.log(`${C.green}Context budget set to ${value}.${C.reset}`); }
      }
      break;
    }
    case 'privacy': {
      if (!rest) { privacyStatus(); break; }
      const [providerName, field, setting] = rest.split(/\s+/);
      if (providerName && !field) { PROVIDERS[providerName] ? privacyStatus(providerName) : console.log(`${C.yellow}Unknown provider.${C.reset}`); break; }
      if (!PROVIDERS[providerName] || !['universal', 'attached', 'history', 'native'].includes(field) || !['on', 'off'].includes(setting)) {
        console.log(`${C.yellow}Usage: /privacy <provider> <universal|attached|history|native> <on|off>${C.reset}`);
      } else {
        state.privacy[providerName] = { ...privacyFor(state, providerName), [field]: setting === 'on' };
        delete tab.sessions[providerName];
        save(); privacyStatus(providerName);
      }
      break;
    }
    case 'sessions': {
      const [action, providerName] = rest.split(/\s+/);
      if (!rest) sessionsStatus(tab);
      else if (action === 'reset' && (!providerName || PROVIDERS[providerName])) {
        if (providerName) delete tab.sessions[providerName]; else tab.sessions = {};
        save(); console.log(`${C.green}Native session state reset.${C.reset}`);
      } else console.log(`${C.yellow}Usage: /sessions or /sessions reset [provider]${C.reset}`);
      break;
    }
    case 'summary':
      if (!rest) console.log(`${C.bold}Rolling summary${C.reset}\n${tab.summary || '(none yet)'}`);
      else if (rest === 'now') {
        busy = true; rl.pause();
        updateSummary(tab, tab.provider, true).then(changed => console.log(changed ? `${C.green}Summary updated.${C.reset}` : `${C.dim}Not enough history to summarize.${C.reset}`)).finally(() => { busy = false; rl.resume(); prompt(); });
        return;
      } else console.log(`${C.yellow}Usage: /summary or /summary now${C.reset}`);
      break;
    case 'git': gitCommand(rest); return;
    case 'agent':
      if (!PROVIDERS[rest]) console.log(`${C.yellow}Choose: ${Object.keys(PROVIDERS).join(', ')}${C.reset}`);
      else { tab.provider = rest; save(); status(); }
      break;
    case 'new': {
      const next = { id: id(), title: rest || 'Untitled task', cwd: tab.cwd, provider: tab.provider, attachedIds: [], messages: [], summary: '', summaryThrough: 0, sessions: {} };
      state.tabs.push(next); state.activeTabId = next.id; save(); status(); break;
    }
    case 'switch': {
      const target = tabAt(rest);
      if (!target) console.log(`${C.yellow}No task numbered ${rest}.${C.reset}`);
      else { state.activeTabId = target.id; save(); status(); }
      break;
    }
    case 'rename':
      if (!rest) console.log(`${C.yellow}Usage: /rename <title>${C.reset}`);
      else { tab.title = rest; save(); status(); }
      break;
    case 'cd': {
      const target = path.resolve(tab.cwd, rest || '.');
      try {
        if (!fs.statSync(target).isDirectory()) throw new Error('not a directory');
        tab.cwd = target;
        tab.sessions = {};
        save();
        console.log(`${C.green}Working directory: ${target}${C.reset}`);
      } catch { console.log(`${C.yellow}Directory not found: ${target}${C.reset}`); }
      break;
    }
    case 'attach': {
      const target = tabAt(rest);
      if (!target || target.id === tab.id) console.log(`${C.yellow}Choose another task number from /tabs.${C.reset}`);
      else { tab.attachedIds = [...new Set([...(tab.attachedIds || []), target.id])]; save(); status(); }
      break;
    }
    case 'detach': {
      const target = tabAt(rest);
      if (!target) console.log(`${C.yellow}No task numbered ${rest}.${C.reset}`);
      else { tab.attachedIds = (tab.attachedIds || []).filter(tid => tid !== target.id); save(); status(); }
      break;
    }
    case 'context':
      if (!rest) console.log(`${C.bold}Universal context${C.reset}\n${state.universalContext || '(empty)'}`);
      else if (rest.startsWith('set ')) { state.universalContext = rest.slice(4); save(); console.log(`${C.green}Context replaced.${C.reset}`); }
      else if (rest.startsWith('add ')) { state.universalContext += `${state.universalContext ? '\n' : ''}${rest.slice(4)}`; save(); console.log(`${C.green}Context added.${C.reset}`); }
      else console.log(`${C.yellow}Usage: /context, /context set <text>, or /context add <text>${C.reset}`);
      break;
    case 'clear': tab.messages = []; tab.summary = ''; tab.summaryThrough = 0; tab.sessions = {}; save(); console.log(`${C.green}Conversation, summary, and native sessions cleared.${C.reset}`); break;
    case 'restart': restarting = true; save(); rl.close(); return;
    case 'exit': save(); rl.close(); return;
    default: console.log(`${C.yellow}Unknown command. Type /help.${C.reset}`);
  }
  prompt();
}

rl.on('line', line => {
  const text = line.trim();
  if (!text) return prompt();
  if (text.startsWith('/')) command(text);
  else askAgent(text);
});
rl.on('SIGINT', () => { console.log('\n'); save(); rl.close(); });
rl.on('close', () => {
  if (restarting) {
    console.log(`${C.dim}Restarting Context IDE…${C.reset}`);
    const child = spawn(process.execPath, [__filename], { cwd: process.cwd(), env: process.env, stdio: 'inherit' });
    child.on('error', error => { console.error(`${C.red}Restart failed: ${error.message}${C.reset}`); process.exit(1); });
    child.on('exit', (code, signal) => {
      if (signal) process.kill(process.pid, signal);
      else process.exit(code ?? 0);
    });
    return;
  }
  console.log(`${C.dim}Workspace saved. Bye.${C.reset}`);
  process.exit(0);
});

banner();
prompt();
