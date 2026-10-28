// Score rules shared by the Vercel API and the PC storage server.
export const SCORES_PREFIX = 'scores/';
export const PC_URL_PATH = 'pc-url.json';
export const SNAPSHOT_PATH = 'board-snapshot.json';
const MAX_ENTRIES_PER_TARGET = 300;

// Offline scores are stored as one blob each, with the score encoded in the pathname.
export function encodeEntry(entry) {
  const packed = [entry.id, entry.name, entry.enrollment, entry.target, entry.stopped, entry.ts];
  return Buffer.from(JSON.stringify(packed)).toString('base64url');
}

function withDelta({ id, name, enrollment, target, stopped, ts }) {
  const delta = Math.round((stopped - target) * 1000) / 1000;
  return { id, name, enrollment, target, stopped, delta, absDelta: Math.abs(delta), ts };
}

export function decodeEntry(pathname) {
  try {
    const encoded = pathname.slice(SCORES_PREFIX.length).replace(/\.json$/, '');
    const [id, name, enrollment, target, stopped, ts] = JSON.parse(Buffer.from(encoded, 'base64url').toString());
    return withDelta({ id, name, enrollment, target, stopped, ts });
  } catch {
    return null;
  }
}

function cleanText(value, maxLength) {
  return String(value ?? '').replace(/[\u0000-\u001f]/g, '').trim().slice(0, maxLength);
}

// Validates a submitted score and returns a stored entry, or null if invalid.
export function buildEntry(body) {
  const name = cleanText(body?.name, 40);
  const enrollment = cleanText(body?.enrollment, 30);
  const target = Number(body?.target);
  const stopped = Number(body?.stopped);

  if (!name || !enrollment) return null;
  if (!Number.isFinite(target) || target < 1 || target > 60) return null;
  if (!Number.isFinite(stopped) || stopped <= 0 || stopped > target * 5) return null;

  const ts = Date.now();
  return withDelta({
    id: `${ts}-${Math.random().toString(36).slice(2, 8)}`,
    name,
    enrollment,
    target: Math.round(target * 10) / 10,
    stopped: Math.round(stopped * 1000) / 1000,
    ts
  });
}

// Best results for each target, so responses stay small.
export function trimBoard(entries) {
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
