/**
 * Memory cleanup policy (§6.3).
 * @module mind/cleanup
 */

/**
 * Retention score — higher is more valuable (purge lowest first).
 * score = 0.6*max(scores) + 0.3*recency + 0.1*log(access)
 *
 * @param {import('./types.js').MemoryRecord} record
 * @param {number} now
 * @returns {number}
 */
export function retentionScore(record, now = Date.now()) {
  const scores = record.scores && typeof record.scores === 'object' ? record.scores : {};
  const values = Object.values(scores).map(Number).filter((n) => Number.isFinite(n));
  const maxScore = values.length ? Math.max(...values) : 0;

  // recency in [0,1]: half-life ~ 1 day of ms
  const ageMs = Math.max(0, now - (Number(record.updatedAt) || Number(record.createdAt) || now));
  const halfLife = 24 * 60 * 60 * 1000;
  const recency = Math.exp(-ageMs / halfLife);

  const access = Math.max(0, Number(record.accessCount) || 0);
  const accessTerm = Math.log1p(access);

  return 0.6 * maxScore + 0.3 * recency + 0.1 * accessTerm;
}

/**
 * Enforce session / per-NPC active caps by purging lowest retention scores.
 *
 * @param {import('./types.js').MemoryRecord[]} records  // mutated in place
 * @param {{ sessionCap?: number, npcCap?: number, now?: number }} [options]
 * @returns {{ removedExpired: number, activeCount: number }}
 */
export function enforceActiveCaps(records, options = {}) {
  const sessionCap = Number.isFinite(options.sessionCap) ? options.sessionCap : 200;
  const npcCap = Number.isFinite(options.npcCap) ? options.npcCap : 120;
  const now = Number.isFinite(options.now) ? options.now : Date.now();
  let removed = 0;

  const active = () => records.filter((r) => r.status === 'active');

  // Per-NPC cap first
  /** @type {Map<string, import('./types.js').MemoryRecord[]>} */
  const byNpc = new Map();
  for (const r of active()) {
    const list = byNpc.get(r.npcId) || [];
    list.push(r);
    byNpc.set(r.npcId, list);
  }
  for (const list of byNpc.values()) {
    if (list.length <= npcCap) continue;
    list.sort((a, b) => retentionScore(a, now) - retentionScore(b, now));
    const excess = list.length - npcCap;
    for (let i = 0; i < excess; i += 1) {
      list[i].status = 'purged';
      list[i].updatedAt = now;
      removed += 1;
    }
  }

  // Session cap
  let remaining = active();
  if (remaining.length > sessionCap) {
    remaining.sort((a, b) => retentionScore(a, now) - retentionScore(b, now));
    const excess = remaining.length - sessionCap;
    for (let i = 0; i < excess; i += 1) {
      remaining[i].status = 'purged';
      remaining[i].updatedAt = now;
      removed += 1;
    }
  }

  return {
    removedExpired: removed,
    activeCount: active().length,
  };
}
