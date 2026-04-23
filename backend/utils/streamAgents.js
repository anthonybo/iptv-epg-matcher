/**
 * Shared HTTP/HTTPS agents and ffprobe runner for live-event stream testing.
 * Centralised so every route handler shares one connection pool and a single
 * promisified execFile instance — this is what keeps parallel Stalker token
 * refreshes and ffprobe batches from exhausting sockets.
 */

const { execFile } = require('child_process');
const { promisify } = require('util');
const http = require('http');
const https = require('https');

const execFileAsync = promisify(execFile);

const httpAgent = new http.Agent({
  keepAlive: true,
  maxSockets: 10,        // Limit concurrent connections per host
  maxFreeSockets: 5,
  timeout: 10000,        // 10 second socket timeout
  keepAliveMsecs: 5000
});

const httpsAgent = new https.Agent({
  keepAlive: true,
  maxSockets: 10,
  maxFreeSockets: 5,
  timeout: 10000,
  keepAliveMsecs: 5000
});

module.exports = {
  execFileAsync,
  httpAgent,
  httpsAgent
};
