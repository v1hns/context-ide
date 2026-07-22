'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const https = require('node:https');
const http = require('node:http');
const { spawn } = require('node:child_process');

// Built-in providers driven by a locally installed, subscription-authenticated
// CLI. Custom providers (see buildRegistry) can add more CLIs or reach an
// OpenAI-compatible HTTP API for experimenting with other models.
const PROVIDERS = {
  codex: { command: 'codex', type: 'codex', nativeSessions: true, setup: 'Install Codex CLI and run: codex login' },
  claude: { command: 'claude', type: 'claude', nativeSessions: true, setup: 'Install Claude Code and run: claude auth login' },
  kimi: { command: 'kimi', type: 'cli-simple', nativeSessions: false, setup: 'Install Kimi Code CLI and run: kimi login' },
  gemini: { command: 'gemini', type: 'cli-simple', nativeSessions: false, setup: 'Install @google/gemini-cli and sign in with Google' },
  copilot: { command: 'copilot', type: 'cli-copilot', nativeSessions: false, setup: 'Install GitHub Copilot CLI and run: copilot login' }
};

// Merge built-in providers with user-imported custom definitions stored in the
// workspace. Custom entries are normalized and never claim native sessions.
function buildRegistry(custom = []) {
  const registry = {};
  for (const [name, def] of Object.entries(PROVIDERS)) registry[name] = { name, custom: false, ...def };
  for (const def of custom || []) {
    if (!def || !def.name) continue;
    registry[def.name] = normalizeCustom(def);
  }
  return registry;
}

function normalizeCustom(def) {
  const base = { name: def.name, custom: true, nativeSessions: false };
  if (def.type === 'openai') {
    return {
      ...base,
      type: 'openai',
      baseUrl: (def.baseUrl || 'https://api.openai.com/v1').replace(/\/$/, ''),
      model: def.model || 'gpt-4o-mini',
      apiKeyEnv: def.apiKeyEnv || 'OPENAI_API_KEY',
      setup: `Set ${def.apiKeyEnv || 'OPENAI_API_KEY'} in the environment (OpenAI-compatible API at ${def.baseUrl || 'https://api.openai.com/v1'})`
    };
  }
  // Generic CLI: run `command` with an args template. A "{prompt}" token in the
  // args is replaced by the prompt; otherwise the prompt is piped on stdin.
  return {
    ...base,
    type: 'cli-template',
    command: def.command,
    args: Array.isArray(def.args) ? def.args : ['-p', '{prompt}'],
    setup: def.setup || `Install the ${def.command} CLI and authenticate it`
  };
}

function commandExists(command) {
  if (!command) return false;
  return (process.env.PATH || '').split(path.delimiter).some(folder => {
    try { fs.accessSync(path.join(folder, command), fs.constants.X_OK); return true; } catch { return false; }
  });
}

// True when a provider can actually run right now: CLI providers need their
// binary on PATH; API providers need their key present in the environment.
function providerAvailable(def) {
  if (!def) return false;
  if (def.type === 'openai') return Boolean(process.env[def.apiKeyEnv]);
  return commandExists(def.command);
}

function providerSetup(def) {
  return def?.setup || 'Provider is not configured.';
}

function run(command, args, input, cwd = process.cwd()) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env: process.env, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', code => code === 0
      ? resolve({ stdout: stdout.trim(), stderr: stderr.trim() })
      : reject(new Error(stderr.trim() || stdout.trim() || `${command} exited with code ${code}`)));
    child.stdin.end(input || '');
  });
}

function postJson(url, headers, payload, timeout = 120000) {
  return new Promise((resolve, reject) => {
    let target;
    try { target = new URL(url); } catch (error) { return reject(error); }
    const body = JSON.stringify(payload);
    const transport = target.protocol === 'http:' ? http : https;
    const request = transport.request({
      hostname: target.hostname,
      port: target.port || (target.protocol === 'http:' ? 80 : 443),
      path: target.pathname + target.search,
      method: 'POST',
      timeout,
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body), ...headers }
    }, response => {
      let data = '';
      response.setEncoding('utf8');
      response.on('data', chunk => { data += chunk; });
      response.on('end', () => {
        if (response.statusCode < 200 || response.statusCode >= 300) {
          let message = `HTTP ${response.statusCode}`;
          try { message = JSON.parse(data).error?.message || message; } catch { /* keep status */ }
          return reject(new Error(message));
        }
        try { resolve(JSON.parse(data)); } catch (error) { reject(error); }
      });
    });
    request.on('timeout', () => request.destroy(new Error('request timed out')));
    request.on('error', reject);
    request.end(body);
  });
}

function parseCodexJson(stdout) {
  let sessionId;
  let answer = '';
  let usage = {};
  for (const line of stdout.split('\n')) {
    try {
      const event = JSON.parse(line);
      if (event.type === 'thread.started') sessionId = event.thread_id;
      if (event.type === 'item.completed' && event.item?.type === 'agent_message') answer = event.item.text || answer;
      if (event.type === 'turn.completed' && event.usage) usage = event.usage;
    } catch { /* ignore non-event output */ }
  }
  return { answer, sessionId, usage };
}

function parseClaudeOutput(output) {
  const parsed = JSON.parse(output);
  if (parsed.is_error || parsed.api_error_status) throw new Error(parsed.result || parsed.error?.message || 'Claude request failed');
  return { answer: parsed.result || parsed.output || '', sessionId: parsed.session_id, usage: parsed.usage || {} };
}

async function runOpenAI(def, prompt) {
  const key = process.env[def.apiKeyEnv];
  if (!key) throw new Error(`${def.apiKeyEnv} is not set`);
  const data = await postJson(`${def.baseUrl}/chat/completions`, { authorization: `Bearer ${key}` }, {
    model: def.model,
    messages: [{ role: 'user', content: prompt }]
  });
  const answer = data.choices?.[0]?.message?.content || '';
  return { answer, usage: data.usage || {} };
}

async function runProvider(name, prompt, options = {}) {
  const provider = options.provider || PROVIDERS[name];
  if (!provider) throw new Error(`Unknown provider: ${name}`);
  const cwd = options.cwd || process.cwd();
  const type = provider.type || name;

  if (type === 'openai') return runOpenAI(provider, prompt);

  if (type === 'cli-template') {
    const args = provider.args.map(arg => arg === '{prompt}' ? prompt : arg);
    const usesStdin = !provider.args.includes('{prompt}');
    const result = await run(provider.command, args, usesStdin ? prompt : '', cwd);
    return { answer: result.stdout };
  }

  if (type === 'codex' || name === 'codex') {
    // A resume keeps the session's original model; a fresh exec honors --model.
    const args = options.sessionId && !options.ephemeral
      ? ['exec', 'resume', '--json', '--skip-git-repo-check', options.sessionId, '-']
      : ['exec', '--json', '--skip-git-repo-check', ...(options.model ? ['--model', options.model] : []), ...(options.ephemeral ? ['--ephemeral'] : []), '-'];
    const result = await run('codex', args, prompt, cwd);
    return parseCodexJson(result.stdout);
  }

  if (type === 'claude' || name === 'claude') {
    const newId = !options.sessionId && !options.ephemeral ? crypto.randomUUID() : undefined;
    const sessionArgs = options.ephemeral
      ? ['--no-session-persistence']
      : options.sessionId ? ['--resume', options.sessionId] : ['--session-id', newId];
    const modelArgs = options.model ? ['--model', options.model] : [];
    try {
      const result = await run('claude', ['--print', '--output-format', 'json', ...modelArgs, ...sessionArgs], prompt, cwd);
      try {
        const parsed = parseClaudeOutput(result.stdout);
        return { ...parsed, sessionId: parsed.sessionId || options.sessionId || newId };
      } catch (error) {
        if (error instanceof SyntaxError) return { answer: result.stdout, sessionId: options.sessionId || newId, usage: {} };
        throw error;
      }
    } catch (error) {
      try { parseClaudeOutput(error.message); } catch (parsedError) {
        if (!(parsedError instanceof SyntaxError)) throw parsedError;
      }
      throw error;
    }
  }

  if (type === 'cli-copilot' || name === 'copilot') {
    const result = await run('copilot', ['-p', prompt, '-s'], '', cwd);
    return { answer: result.stdout };
  }

  // cli-simple (kimi, gemini) and any other single-shot CLI.
  const result = await run(provider.command || name, ['-p', prompt, ...(name === 'kimi' ? ['--output-format', 'text'] : [])], '', cwd);
  return { answer: result.stdout };
}

module.exports = {
  PROVIDERS,
  buildRegistry,
  commandExists,
  normalizeCustom,
  parseClaudeOutput,
  postJson,
  providerAvailable,
  providerSetup,
  run,
  runProvider
};
