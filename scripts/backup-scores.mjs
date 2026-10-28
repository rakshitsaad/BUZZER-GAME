// Copies every score from the shared Vercel Blob leaderboard to this laptop.
// Writes backups/scores.json (full history, merged by id so nothing is ever
// dropped) and backups/scores.csv (opens in Excel), then logs to backups/backup.log.
// Usage: node scripts/backup-scores.mjs
import { list } from '@vercel/blob';
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { decodeEntry } from '../api/scores.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const BACKUP_DIR = join(ROOT, 'backups');
const JSON_PATH = join(BACKUP_DIR, 'scores.json');
const CSV_PATH = join(BACKUP_DIR, 'scores.csv');
const LOG_PATH = join(BACKUP_DIR, 'backup.log');

function log(message) {
  appendFileSync(LOG_PATH, `${new Date().toISOString()}  ${message}\n`);
}

// Only the read-write token is used; the short-lived OIDC token in .env.local expires.
function readBlobToken() {
  const env = readFileSync(join(ROOT, '.env.local'), 'utf8');
  const match = env.match(/^BLOB_READ_WRITE_TOKEN="?([^"\r\n]+)"?/m);
  if (!match) throw new Error('BLOB_READ_WRITE_TOKEN missing from .env.local (run: npx vercel env pull .env.local)');
  return match[1];
}

async function fetchAllScores(token) {
  const entries = [];
  let cursor;
  do {
    const page = await list({ prefix: 'scores/', limit: 1000, cursor, token });
    for (const blob of page.blobs) {
      const entry = decodeEntry(blob.pathname);
      if (entry) entries.push(entry);
    }
    cursor = page.hasMore ? page.cursor : undefined;
  } while (cursor);
  return entries;
}

function readExistingBackup() {
  if (!existsSync(JSON_PATH)) return [];
  return JSON.parse(readFileSync(JSON_PATH, 'utf8'));
}

function csvCell(value) {
  const text = String(value ?? '');
  // Leading = + - @ would be run as a formula by Excel
  const safe = /^[=+\-@]/.test(text) && Number.isNaN(Number(text)) ? `'${text}` : text;
  return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

function toCsv(entries) {
  const header = ['Rank (per target)', 'Name', 'Enrollment', 'Target (s)', 'Stopped (s)', 'Delta (s)', 'Played at', 'Score ID'];
  const rows = [];
  const rankByTarget = new Map();
  for (const e of entries) {
    const rank = (rankByTarget.get(e.target) || 0) + 1;
    rankByTarget.set(e.target, rank);
    rows.push([rank, e.name, e.enrollment, e.target, e.stopped.toFixed(3), e.delta.toFixed(3), new Date(e.ts).toLocaleString('en-IN'), e.id]);
  }
  // BOM so Excel reads names with accents correctly
  return '﻿' + [header, ...rows].map(r => r.map(csvCell).join(',')).join('\r\n') + '\r\n';
}

function writeSafely(path, content) {
  writeFileSync(`${path}.tmp`, content);
  renameSync(`${path}.tmp`, path);
}

async function main() {
  mkdirSync(BACKUP_DIR, { recursive: true });
  const online = await fetchAllScores(readBlobToken());

  const byId = new Map(readExistingBackup().map(e => [e.id, e]));
  let added = 0;
  for (const entry of online) {
    if (!byId.has(entry.id)) added++;
    byId.set(entry.id, entry);
  }
  const all = [...byId.values()].sort((a, b) => a.target - b.target || a.absDelta - b.absDelta);

  writeSafely(JSON_PATH, JSON.stringify(all, null, 2));
  try {
    writeSafely(CSV_PATH, toCsv(all));
  } catch (error) {
    // Usually means scores.csv is open in Excel; the JSON backup is still saved
    log(`WARN  could not update scores.csv (${error.code || error.message}); will retry next run`);
  }
  log(`OK    ${online.length} online, ${added} new, ${all.length} total backed up`);
  console.log(`Backed up ${all.length} scores (${added} new) to ${BACKUP_DIR}`);
}

main().catch(error => {
  mkdirSync(BACKUP_DIR, { recursive: true });
  log(`ERROR ${error.message}`);
  console.error(error);
  process.exit(1);
});
