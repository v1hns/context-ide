'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');

const PROVIDERS = {
  codex: { command: 'codex', nativeSessions: true, setup: 'Install Codex CLI and run: codex login' },
  claude: { command: 'claude', nativeSessions: true, setup: 'Install Claude Code and run: claude auth login' },
  kimi: { command: 'kimi', nativeSessions: false, setup: 'Install Kimi Code CLI and run: kimi login' },
  gemini: { command: 'gemini', nativeSessions: false, setup: 'Install @google/gemini-cli and sign in with Google' },
  copilot: { command: 'copilot', nativeSessions: false, setup: 'Install GitHub Copilot CLI and run: copilot login' }
};

function commandExists(command) {
  return (process.env.PATH || '').split(path.delimiter).some(folder => {
    try { fs.accessSync(path.join(folder, command), fs.constants.X_OK); return true; } catch { return false; }
  });
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

async function runProvider(name, prompt, options = {}) {
  const provider = PROVIDERS[name];
  if (!provider) throw new Error(`Unknown provider: ${name}`);
  const cwd = options.cwd || process.cwd();
  if (name === 'codex') {
    const args = options.sessionId && !options.ephemeral
      ? ['exec', 'resume', '--json', '--skip-git-repo-check', options.sessionId, '-']
      : ['exec', '--json', '--skip-git-repo-check', ...(options.ephemeral ? ['--ephemeral'] : []), '-'];
    const result = await run('codex', args, prompt, cwd);
    return parseCodexJson(result.stdout);
  }
  if (name === 'claude') {
    const newId = !options.sessionId && !options.ephemeral ? crypto.randomUUID() : undefined;
    const sessionArgs = options.ephemeral
      ? ['--no-session-persistence']
      : options.sessionId ? ['--resume', options.sessionId] : ['--session-id', newId];
    const result = await run('claude', ['--print', '--output-format', 'json', ...sessionArgs], prompt, cwd);
    try {
      const parsed = JSON.parse(result.stdout);
      return { answer: parsed.result || parsed.output || '', sessionId: parsed.session_id || options.sessionId || newId, usage: parsed.usage || {} };
    } catch {
      return { answer: result.stdout, sessionId: options.sessionId || newId, usage: {} };
    }
  }
  if (name === 'kimi') {
    const result = await run('kimi', ['-p', prompt, '--output-format', 'text'], '', cwd);
    return { answer: result.stdout };
  }
  if (name === 'gemini') {
    const result = await run('gemini', ['-p', prompt], '', cwd);
    return { answer: result.stdout };
  }
  const result = await run('copilot', ['-p', prompt, '-s'], '', cwd);
  return { answer: result.stdout };
}

module.exports = { PROVIDERS, commandExists, run, runProvider };
