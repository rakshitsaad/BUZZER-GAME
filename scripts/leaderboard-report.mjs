// Prints the current leaderboard (best attempt per player, per target) and writes
// every attempt, ranked, to backups/leaderboard-export.csv.
// Combines the PC copy (backups/scores.json) with scores saved to Vercel while the PC
// was off. Costs one Vercel Blob list operation per run.
// Usage: node scripts/leaderboard-report.mjs [top N, default 10]
import { list } from '@vercel/blob';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { decodeEntry, SCORES_PREFIX } from '../lib/scores-core.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const TOP = Number(process.argv[2]) || 10;

function readBlobToken() {
  const env = readFileSync(join(ROOT, '.env.local'), 'utf8');
  return env.match(/^BLOB_READ_WRITE_TOKEN="?([^"\r\n]+)"?/m)?.[1];
}

async function fetchOfflineScores(token) {
  const entries = [];
  let cursor;
  do {
    const page = await list({ prefix: SCORES_PREFIX, limit: 1000, cursor, token });
    entries.push(...page.blobs.map(b => decodeEntry(b.pathname)).filter(Boolean));
    cursor = page.hasMore ? page.cursor : undefined;
  } while (cursor);
  return entries;
}

const ist = ts => new Date(ts).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
const fmtDelta = d => (d >= 0 ? '+' : '') + d.toFixed(3) + 's';

function csvCell(value) {
  const text = String(value ?? '');
  const safe = /^[=+\-@]/.test(text) && Number.isNaN(Number(text)) ? `'${text}` : text;
  return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

const pcPath = join(ROOT, 'backups', 'scores.json');
const pcScores = existsSync(pcPath) ? JSON.parse(readFileSync(pcPath, 'utf8')) : [];
const offline = await fetchOfflineScores(readBlobToken());
const all = [...new Map([...pcScores, ...offline].map(e => [e.id, e])).values()];

const players = new Set(all.map(e => e.enrollment.toUpperCase())).size;
console.log(`${all.length} scores from ${players} players (${pcScores.length} on PC, ${offline.length} saved to Vercel while PC was off)`);
console.log(`From ${ist(Math.min(...all.map(e => e.ts)))} to ${ist(Math.max(...all.map(e => e.ts)))} IST`);

const csvRows = [['Target (s)', 'Rank', 'Name', 'Enrollment', 'Stopped (s)', 'Delta (s)', 'Played at (IST)']];
for (const target of [...new Set(all.map(e => e.target))].sort((a, b) => a - b)) {
  const attempts = all.filter(e => e.target === target).sort((a, b) => a.absDelta - b.absDelta);
  attempts.forEach((e, i) => csvRows.push([target, i + 1, e.name.trim(), e.enrollment, e.stopped.toFixed(3), e.delta.toFixed(3), ist(e.ts)]));

  const best = new Map();
  for (const e of attempts) if (!best.has(e.enrollment.toUpperCase())) best.set(e.enrollment.toUpperCase(), e);
  console.log(`\n## ${target}s target: ${attempts.length} attempts, ${best.size} players`);
  [...best.values()].slice(0, TOP).forEach((e, i) =>
    console.log(`${i + 1} | ${e.name.trim()} | ${e.enrollment} | ${fmtDelta(e.delta)} | ${ist(e.ts)}`)
  );
}

mkdirSync(join(ROOT, 'backups'), { recursive: true });
writeFileSync(join(ROOT, 'backups', 'leaderboard-export.csv'), '﻿' + csvRows.map(r => r.map(csvCell).join(',')).join('\r\n') + '\r\n');
console.log('\nFull ranked list: backups/leaderboard-export.csv');
