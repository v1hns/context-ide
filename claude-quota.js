#!/usr/bin/env node
'use strict';

const { execFileSync } = require('node:child_process');
const https = require('node:https');

function accessToken() {
  if (process.platform !== 'darwin') return null;
  const raw = execFileSync('security', ['find-generic-password', '-s', 'Claude Code-credentials', '-w'], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 3000, maxBuffer: 8 * 1024 * 1024
  });
  return JSON.parse(raw).claudeAiOauth?.accessToken || null;
}

function fetchQuota(token) {
  return new Promise((resolve, reject) => {
    const request = https.request({
      hostname: 'api.anthropic.com', path: '/api/oauth/usage', method: 'GET', timeout: 5000,
      headers: { authorization: `Bearer ${token}`, 'anthropic-beta': 'oauth-2025-04-20' }
    }, response => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', chunk => { body += chunk; });
      response.on('end', () => response.statusCode === 200 ? resolve(JSON.parse(body)) : reject(new Error(`HTTP ${response.statusCode}`)));
    });
    request.on('timeout', () => request.destroy(new Error('timeout')));
    request.on('error', reject);
    request.end();
  });
}

(async () => {
  try {
    const token = accessToken();
    if (!token) process.exit(2);
    const data = await fetchQuota(token);
    const safe = {
      five_hour: data.five_hour && { utilization: data.five_hour.utilization, resets_at: data.five_hour.resets_at },
      seven_day: data.seven_day && { utilization: data.seven_day.utilization, resets_at: data.seven_day.resets_at }
    };
    process.stdout.write(JSON.stringify(safe));
  } catch { process.exit(1); }
})();
