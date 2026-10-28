import { get, put } from '@vercel/blob';
import { buildEntry, encodeEntry, PC_URL_PATH, SCORES_PREFIX, SNAPSHOT_PATH } from '../lib/scores-core.js';

// Shared leaderboard for every player.
// The owner's PC (scripts/pc-storage.mjs, reached through a Cloudflare tunnel) is the
// main storage. While it is unreachable, scores go to Vercel Blob one blob per score,
// and players see the last board snapshot the PC uploaded. The PC imports those
// scores when it comes back. This keeps Blob usage well inside the free plan.
const PC_TIMEOUT_MS = 4000;
const PC_URL_CACHE_MS = 30_000;

let cachedPcUrl = null;
let cachedPcUrlAt = 0;

async function readBlobJson(pathname) {
  const result = await get(pathname, { access: 'public' });
  if (!result || result.statusCode !== 200) return null;
  return JSON.parse(await new Response(result.stream).text());
}

async function getPcUrl() {
  if (Date.now() - cachedPcUrlAt > PC_URL_CACHE_MS) {
    cachedPcUrl = (await readBlobJson(PC_URL_PATH).catch(() => null))?.url || null;
    cachedPcUrlAt = Date.now();
  }
  return cachedPcUrl;
}

// Returns the PC's JSON response, or null if the PC is off or unreachable.
async function callPc(method, body) {
  const pcUrl = await getPcUrl();
  const secret = process.env.PC_SHARED_SECRET;
  if (!pcUrl || !secret) return null;
  try {
    const res = await fetch(`${pcUrl}/scores`, {
      method,
      headers: { 'Content-Type': 'application/json', 'x-pc-secret': secret },
      body: body && JSON.stringify(body),
      signal: AbortSignal.timeout(PC_TIMEOUT_MS)
    });
    if (res.status === 400) return { invalid: true };
    if (!res.ok) throw new Error(`PC responded ${res.status}`);
    return await res.json();
  } catch (error) {
    console.warn('PC storage unreachable', error.message);
    cachedPcUrlAt = 0; // re-read the address next time in case the tunnel restarted
    return null;
  }
}

function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers }
  });
}

export async function GET() {
  const fromPc = await callPc('GET');
  if (fromPc?.entries) {
    return json({ entries: fromPc.entries, source: 'pc' }, 200, { 'Cache-Control': 'public, s-maxage=5, stale-while-revalidate=10' });
  }
  try {
    const snapshot = (await readBlobJson(SNAPSHOT_PATH)) || [];
    return json({ entries: snapshot, source: 'snapshot' }, 200, { 'Cache-Control': 'public, s-maxage=30, stale-while-revalidate=60' });
  } catch (error) {
    console.error('Leaderboard read failed', error);
    return json({ error: 'Could not load leaderboard' }, 500);
  }
}

export async function POST(request) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'Invalid JSON' }, 400);
  }

  const entry = buildEntry(body || {});
  if (!entry) return json({ error: 'Invalid score' }, 400);

  const fromPc = await callPc('POST', body);
  if (fromPc?.invalid) return json({ error: 'Invalid score' }, 400);
  if (fromPc?.entry) return json({ entry: fromPc.entry, source: 'pc' }, 201);

  try {
    await put(`${SCORES_PREFIX}${encodeEntry(entry)}.json`, '{}', {
      access: 'public',
      contentType: 'application/json',
      addRandomSuffix: false
    });
    return json({ entry, source: 'vercel' }, 201);
  } catch (error) {
    console.error('Leaderboard write failed', error);
    return json({ error: 'Could not save score' }, 500);
  }
}
