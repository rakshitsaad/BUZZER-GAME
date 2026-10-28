// Main leaderboard storage, running on this PC.
// - Saves every score to backups/scores.json (and backups/scores.csv for Excel).
// - Serves the board on 127.0.0.1 only; a Cloudflare quick tunnel makes it reachable
//   for the Vercel API, which must send the shared secret from .env.pc.
// - Publishes the tunnel address to Vercel Blob so the API can find this PC.
// - Every few hours, imports scores saved to Vercel while this PC was off and
//   uploads a board snapshot that players see while this PC is off.
// Usage: node scripts/pc-storage.mjs
import { del, list, put } from '@vercel/blob';
import { spawn } from 'node:child_process';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildEntry, decodeEntry, PC_URL_PATH, SCORES_PREFIX, SNAPSHOT_PATH, trimBoard } from '../lib/scores-core.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const BACKUP_DIR = join(ROOT, 'backups');
const JSON_PATH = join(BACKUP_DIR, 'scores.json');
const CSV_PATH = join(BACKUP_DIR, 'scores.csv');
const LOG_PATH = join(BACKUP_DIR, 'pc-storage.log');
const PC_ENV_PATH = join(ROOT, '.env.pc');
const PORT = 8787;
const CLOUDFLARED = 'C:\\Program Files (x86)\\cloudflared\\cloudflared.exe';
// Each sync costs 1-2 Vercel Blob "advanced operations" (2,000/month on the free plan)
const SYNC_INTERVAL_MS = 3 * 60 * 60 * 1000;

mkdirSync(BACKUP_DIR, { recursive: true });

function log(message) {
  const line = `${new Date().toISOString()}  ${message}`;
  appendFileSync(LOG_PATH, line + '\n');
  console.log(line);
}

function readEnvValue(path, key) {
  if (!existsSync(path)) return null;
  const match = readFileSync(path, 'utf8').match(new RegExp(`^${key}="?([^"\\r\\n]+)"?`, 'm'));
  return match ? match[1] : null;
}

// The secret is created once and must match PC_SHARED_SECRET in the Vercel project.
function loadSecret() {
  let secret = readEnvValue(PC_ENV_PATH, 'PC_SHARED_SECRET');
  if (!secret) {
    secret = randomBytes(32).toString('hex');
    writeFileSync(PC_ENV_PATH, `PC_SHARED_SECRET=${secret}\n`);
    log('Created new PC_SHARED_SECRET in .env.pc (add it to Vercel: npx vercel env add PC_SHARED_SECRET production)');
  }
  return secret;
}

const SECRET = Buffer.from(loadSecret());
const BLOB_TOKEN = readEnvValue(join(ROOT, '.env.local'), 'BLOB_READ_WRITE_TOKEN');
if (!BLOB_TOKEN) log('WARN  BLOB_READ_WRITE_TOKEN missing from .env.local; Vercel sync disabled');

/* ---------- Local score file ---------- */

let scores = existsSync(JSON_PATH) ? JSON.parse(readFileSync(JSON_PATH, 'utf8')) : [];
let lastSnapshotJson = null;

function csvCell(value) {
  const text = String(value ?? '');
  // Leading = + - @ would be run as a formula by Excel
  const safe = /^[=+\-@]/.test(text) && Number.isNaN(Number(text)) ? `'${text}` : text;
  return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

function toCsv(entries) {
  const header = ['Rank (per target)', 'Name', 'Enrollment', 'Target (s)', 'Stopped (s)', 'Delta (s)', 'Played at', 'Score ID'];
  const rankByTarget = new Map();
  const rows = entries.map(e => {
    const rank = (rankByTarget.get(e.target) || 0) + 1;
    rankByTarget.set(e.target, rank);
    return [rank, e.name, e.enrollment, e.target, e.stopped.toFixed(3), e.delta.toFixed(3), new Date(e.ts).toLocaleString('en-IN'), e.id];
  });
  // BOM so Excel reads names with accents correctly
  return '\uFEFF' + [header, ...rows].map(r => r.map(csvCell).join(',')).join('\r\n') + '\r\n';
}

function writeSafely(path, content) {
  writeFileSync(`${path}.tmp`, content);
  renameSync(`${path}.tmp`, path);
}

function saveScores() {
  scores.sort((a, b) => a.target - b.target || a.absDelta - b.absDelta);
  writeSafely(JSON_PATH, JSON.stringify(scores, null, 2));
  try {
    writeSafely(CSV_PATH, toCsv(scores));
  } catch (error) {
    // Usually means scores.csv is open in Excel; it is rewritten on the next save
    log(`WARN  could not update scores.csv (${error.code || error.message})`);
  }
}

function addScores(entries) {
  const known = new Set(scores.map(e => e.id));
  const fresh = entries.filter(e => e && !known.has(e.id));
  if (fresh.length) {
    scores.push(...fresh);
    saveScores();
  }
  return fresh.length;
}

/* ---------- HTTP server (local only) ---------- */

function isAuthorized(req) {
  const given = Buffer.from(String(req.headers['x-pc-secret'] || ''));
  return given.length === SECRET.length && timingSafeEqual(given, SECRET);
}

function send(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => {
      body += chunk;
      if (body.length > 4096) reject(new Error('Body too large'));
    });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

const server = createServer(async (req, res) => {
  const path = new URL(req.url, 'http://localhost').pathname;
  if (path === '/health') return send(res, 200, { ok: true, scores: scores.length });
  if (path !== '/scores') return send(res, 404, { error: 'Not found' });
  if (!isAuthorized(req)) return send(res, 401, { error: 'Unauthorized' });

  if (req.method === 'GET') return send(res, 200, { entries: trimBoard([...scores]) });

  if (req.method === 'POST') {
    let entry;
    try {
      entry = buildEntry(JSON.parse(await readBody(req)));
    } catch {
      return send(res, 400, { error: 'Invalid JSON' });
    }
    if (!entry) return send(res, 400, { error: 'Invalid score' });
    addScores([entry]);
    return send(res, 201, { entry });
  }
  send(res, 405, { error: 'Method not allowed' });
});

/* ---------- Vercel Blob sync ---------- */

const blobOptions = { access: 'public', addRandomSuffix: false, allowOverwrite: true, contentType: 'application/json', token: BLOB_TOKEN };

async function publishTunnelUrl(url) {
  if (!BLOB_TOKEN) return;
  await put(PC_URL_PATH, JSON.stringify({ url, updatedAt: Date.now() }), { ...blobOptions, cacheControlMaxAge: 60 });
  log(`Published tunnel address ${url}`);
}

// Pull in scores saved to Vercel while this PC was unreachable, then upload a fresh snapshot.
async function syncWithVercel() {
  if (!BLOB_TOKEN) return;
  try {
    const offline = [];
    let cursor;
    do {
      const page = await list({ prefix: SCORES_PREFIX, limit: 1000, cursor, token: BLOB_TOKEN });
      offline.push(...page.blobs);
      cursor = page.hasMore ? page.cursor : undefined;
    } while (cursor);

    const added = addScores(offline.map(b => decodeEntry(b.pathname)));
    // Deletes are free; the scores are now safe in scores.json
    if (offline.length) await del(offline.map(b => b.url), { token: BLOB_TOKEN });

    const snapshot = JSON.stringify(trimBoard([...scores]));
    if (snapshot !== lastSnapshotJson) {
      await put(SNAPSHOT_PATH, snapshot, { ...blobOptions, cacheControlMaxAge: 60 });
      lastSnapshotJson = snapshot;
    }
    log(`Synced: ${added} offline scores imported, ${scores.length} total`);
  } catch (error) {
    log(`WARN  sync with Vercel failed: ${error.message}`);
  }
}

/* ---------- Cloudflare quick tunnel ---------- */

function startTunnel() {
  // http2 instead of the default QUIC, which many Wi-Fi networks block
  const tunnel = spawn(CLOUDFLARED, ['tunnel', '--no-autoupdate', '--protocol', 'http2', '--url', `http://127.0.0.1:${PORT}`], { windowsHide: true });
  let published = false;
  const onOutput = data => {
    for (const line of String(data).split('\n')) {
      if (/ ERR |Registered tunnel connection/.test(line)) log(`tunnel: ${line.trim()}`);
    }
    const match = !published && String(data).match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
    if (match) {
      published = true;
      publishTunnelUrl(match[0])
        .then(syncWithVercel)
        .catch(error => log(`WARN  could not publish tunnel address: ${error.message}`));
    }
  };
  tunnel.stdout.on('data', onOutput);
  tunnel.stderr.on('data', onOutput);
  tunnel.on('exit', code => {
    log(`Tunnel stopped (code ${code}); restarting in 10s`);
    setTimeout(startTunnel, 10_000);
  });
}

server.listen(PORT, '127.0.0.1', () => {
  log(`PC storage listening on 127.0.0.1:${PORT} with ${scores.length} saved scores`);
  startTunnel();
  setInterval(syncWithVercel, SYNC_INTERVAL_MS);
});
