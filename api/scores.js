import { list, put } from '@vercel/blob';

// Shared leaderboard for every player, stored in Vercel Blob.
// Each score is its own blob with the score encoded in the pathname, so saves
// never conflict and the board is read with a single list call.
const SCORES_PREFIX = 'scores/';
const MAX_ENTRIES_PER_TARGET = 300;

function encodeEntry(entry) {
  const packed = [entry.id, entry.name, entry.enrollment, entry.target, entry.stopped, entry.ts];
  return Buffer.from(JSON.stringify(packed)).toString('base64url');
}

function decodeEntry(pathname) {
  try {
    const encoded = pathname.slice(SCORES_PREFIX.length).replace(/\.json$/, '');
    const [id, name, enrollment, target, stopped, ts] = JSON.parse(Buffer.from(encoded, 'base64url').toString());
    const delta = Math.round((stopped - target) * 1000) / 1000;
    return { id, name, enrollment, target, stopped, delta, absDelta: Math.abs(delta), ts };
  } catch {
    return null;
  }
}

async function readBoard() {
  const entries = [];
  let cursor;
  do {
    const page = await list({ prefix: SCORES_PREFIX, limit: 1000, cursor });
    for (const blob of page.blobs) {
      const entry = decodeEntry(blob.pathname);
      if (entry) entries.push(entry);
    }
    cursor = page.hasMore ? page.cursor : undefined;
  } while (cursor);
  return trimBoard(entries);
}

function cleanText(value, maxLength) {
  return String(value ?? '').replace(/[\u0000-\u001f]/g, '').trim().slice(0, maxLength);
}

function buildEntry(body) {
  const name = cleanText(body.name, 40);
  const enrollment = cleanText(body.enrollment, 30);
  const target = Number(body.target);
  const stopped = Number(body.stopped);

  if (!name || !enrollment) return null;
  if (!Number.isFinite(target) || target < 1 || target > 60) return null;
  if (!Number.isFinite(stopped) || stopped <= 0 || stopped > target * 5) return null;

  const ts = Date.now();
  return decodeEntry(SCORES_PREFIX + encodeEntry({
    id: `${ts}-${Math.random().toString(36).slice(2, 8)}`,
    name,
    enrollment,
    target: Math.round(target * 10) / 10,
    stopped: Math.round(stopped * 1000) / 1000,
    ts
  }));
}

// Return only the best results for each target so the response stays small.
function trimBoard(entries) {
  const byTarget = new Map();
  for (const entry of entries) {
    const list = byTarget.get(entry.target) || [];
    list.push(entry);
    byTarget.set(entry.target, list);
  }
  return [...byTarget.values()].flatMap(list =>
    list.sort((a, b) => a.absDelta - b.absDelta).slice(0, MAX_ENTRIES_PER_TARGET)
  );
}

function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers }
  });
}

export async function GET() {
  try {
    const entries = await readBoard();
    return json({ entries }, 200, { 'Cache-Control': 'public, s-maxage=5, stale-while-revalidate=10' });
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

  try {
    await put(`${SCORES_PREFIX}${encodeEntry(entry)}.json`, '{}', {
      access: 'public',
      contentType: 'application/json',
      addRandomSuffix: false
    });
    return json({ entry }, 201);
  } catch (error) {
    console.error('Leaderboard write failed', error);
    return json({ error: 'Could not save score' }, 500);
  }
}
