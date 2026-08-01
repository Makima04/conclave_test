/**
 * Memory cleanup policy (§6.3 + PR-12 hardening).
 * @module mind/cleanup
 */

/** Default active caps (architecture §6.3). */
export const DEFAULT_SESSION_CAP = 200;
export const DEFAULT_NPC_CAP = 120;

/**
 * Retention score — higher is more valuable (purge lowest first).
 * score = 0.55*max(scores) + 0.35*recency + 0.10*log1p(access)
 *
 * Recency uses the fresher of updatedAt / lastAccessedAt so retrieved
 * memories resist purge; half-life ~ 1 day.
 *
 * @param {import('./types.js').MemoryRecord} record
 * @param {number} now
 * @returns {number}
 */
export function retentionScore(record, now = Date.now()) {
  const scores = record.scores && typeof record.scores === 'object' ? record.scores : {};
  const values = Object.values(scores)
    .map(Number)
    .filter((n) => Number.isFinite(n));
  const maxScore = values.length ? Math.max(...values) : 0;

  const touchAt = Math.max(
    Number(record.lastAccessedAt) || 0,
    Number(record.updatedAt) || 0,
    Number(record.createdAt) || 0,
  );
  const ageMs = Math.max(0, now - (touchAt || now));
  const halfLife = 24 * 60 * 60 * 1000;
  const recency = Math.exp(-ageMs / halfLife);

  const access = Math.max(0, Number(record.accessCount) || 0);
  const accessTerm = Math.log1p(access);

  return 0.55 * maxScore + 0.35 * recency + 0.1 * accessTerm;
}

/**
 * Sort key for purge order: lowest retention first; ties → older createdAt first;
 * then lower accessCount; then stable id.
 *
 * @param {import('./types.js').MemoryRecord} a
 * @param {import('./types.js').MemoryRecord} b
 * @param {number} now
 * @returns {number}
 */
export function purgeCompare(a, b, now = Date.now()) {
  const sa = retentionScore(a, now);
  const sb = retentionScore(b, now);
  if (sa !== sb) return sa - sb;
  const ca = Number(a.createdAt) || 0;
  const cb = Number(b.createdAt) || 0;
  if (ca !== cb) return ca - cb;
  const aa = Number(a.accessCount) || 0;
  const ab = Number(b.accessCount) || 0;
  if (aa !== ab) return aa - ab;
  return String(a.id || '').localeCompare(String(b.id || ''));
}

/**
 * Mark lowest-retention actives as purged until count ≤ cap.
 * Mutates records in place. Idempotent when already under cap.
 *
 * @param {import('./types.js').MemoryRecord[]} activeList
 * @param {number} cap
 * @param {number} now
 * @returns {number} how many purged
 */
function purgeDownTo(activeList, cap, now) {
  if (!Number.isFinite(cap) || cap < 0) return 0;
  if (activeList.length <= cap) return 0;
  const ordered = activeList.slice().sort((a, b) => purgeCompare(a, b, now));
  const excess = ordered.length - cap;
  let removed = 0;
  for (let i = 0; i < excess; i += 1) {
    const rec = ordered[i];
    if (rec.status === 'purged') continue;
    rec.status = 'purged';
    rec.updatedAt = now;
    removed += 1;
  }
  return removed;
}

/**
 * Enforce session / per-NPC active caps by purging lowest retention scores.
 * Always re-reads active set after per-NPC purges so session cap is reliable
 * even when many inserts land in one batch (50-turn bound).
 *
 * @param {import('./types.js').MemoryRecord[]} records  // mutated in place
 * @param {{ sessionCap?: number, npcCap?: number, now?: number }} [options]
 * @returns {{ removedExpired: number, activeCount: number }}
 */
export function enforceActiveCaps(records, options = {}) {
  const sessionCap = Number.isFinite(options.sessionCap)
    ? options.sessionCap
    : DEFAULT_SESSION_CAP;
  const npcCap = Number.isFinite(options.npcCap) ? options.npcCap : DEFAULT_NPC_CAP;
  const now = Number.isFinite(options.now) ? options.now : Date.now();
  let removed = 0;

  const activeOf = () => (Array.isArray(records) ? records : []).filter((r) => r && r.status === 'active');

  // Per-NPC cap first
  /** @type {Map<string, import('./types.js').MemoryRecord[]>} */
  const byNpc = new Map();
  for (const r of activeOf()) {
    const key = r.npcId != null ? String(r.npcId) : 'primary';
    const list = byNpc.get(key) || [];
    list.push(r);
    byNpc.set(key, list);
  }
  for (const list of byNpc.values()) {
    removed += purgeDownTo(list, npcCap, now);
  }

  // Session cap on remaining actives (re-filter after NPC purges)
  removed += purgeDownTo(activeOf(), sessionCap, now);

  // Safety: if somehow still over (e.g. concurrent status edits), force once more
  const leftover = activeOf();
  if (leftover.length > sessionCap) {
    removed += purgeDownTo(leftover, sessionCap, now);
  }

  return {
    removedExpired: removed,
    activeCount: activeOf().length,
  };
}
