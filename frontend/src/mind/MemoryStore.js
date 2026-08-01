/**
 * In-memory MemoryStore: insert, contentHash dedupe, cleanup, retrieve.
 * @module mind/MemoryStore
 */

import { enforceActiveCaps } from './cleanup.js';
import { contentHash } from './dedupe.js';
import { retrieveMemories } from './retrieval.js';

/**
 * @param {{
 *   sessionCap?: number,
 *   npcCap?: number,
 *   sessionId?: string,
 * }} [options]
 */
export function createMemoryStore(options = {}) {
  const sessionCap = Number.isFinite(options.sessionCap) ? options.sessionCap : 200;
  const npcCap = Number.isFinite(options.npcCap) ? options.npcCap : 120;
  const sessionId = options.sessionId != null ? String(options.sessionId) : '0';

  /** @type {import('./types.js').MemoryRecord[]} */
  const records = [];

  /** @type {import('./types.js').MindCleanupStats} */
  let cleanupStats = {
    lastRunAt: 0,
    removedDedupe: 0,
    removedExpired: 0,
    activeCount: 0,
  };

  function activeCount() {
    return records.filter((r) => r.status === 'active').length;
  }

  /**
   * Insert candidates; dedupe by contentHash among active records.
   * @param {Array<Partial<import('./types.js').MemoryRecord> & { text: string, npcId: string }>} candidates
   * @param {{ now?: number, runCleanup?: boolean }} [opts]
   * @returns {{ inserted: number, merged: number, cleanup: import('./types.js').MindCleanupStats }}
   */
  function insertMany(candidates, opts = {}) {
    const now = Number.isFinite(opts.now) ? opts.now : Date.now();
    let inserted = 0;
    let merged = 0;

    for (const raw of candidates || []) {
      if (!raw || !raw.text || !raw.npcId) continue;
      const hash = raw.contentHash || contentHash(raw.npcId, raw.text);
      const existing = records.find(
        (r) => r.status === 'active' && r.contentHash === hash,
      );

      if (existing) {
        // Keep earlier createdAt; merge labels; scores = max; accessCount++
        const labels = new Set([
          ...(Array.isArray(existing.labels) ? existing.labels : []),
          ...(Array.isArray(raw.labels) ? raw.labels : []),
        ]);
        existing.labels = [...labels];
        const scores = { ...(existing.scores || {}) };
        const incoming = raw.scores && typeof raw.scores === 'object' ? raw.scores : {};
        for (const [axis, val] of Object.entries(incoming)) {
          const n = Number(val);
          if (!Number.isFinite(n)) continue;
          scores[axis] = Math.max(Number(scores[axis]) || 0, n);
        }
        existing.scores = scores;
        existing.accessCount = (Number(existing.accessCount) || 0) + 1;
        existing.lastAccessedAt = now;
        existing.updatedAt = now;
        if (raw.sourceMessageId != null) {
          existing.sourceMessageId = Number(raw.sourceMessageId);
        }
        merged += 1;
        continue;
      }

      /** @type {import('./types.js').MemoryRecord} */
      const record = {
        id: raw.id || `mem_${hash.slice(0, 12)}_${now.toString(36)}_${inserted}`,
        npcId: String(raw.npcId),
        sessionId: raw.sessionId != null ? String(raw.sessionId) : sessionId,
        createdAt: Number(raw.createdAt) || now,
        updatedAt: now,
        sourceMessageId:
          raw.sourceMessageId != null ? Number(raw.sourceMessageId) : undefined,
        text: String(raw.text).slice(0, 200),
        labels:
          Array.isArray(raw.labels) && raw.labels.length
            ? [...raw.labels]
            : ['knowledge/unspecified'],
        scores:
          raw.scores && typeof raw.scores === 'object'
            ? { ...raw.scores }
            : { knowledge: 0.5 },
        contentHash: hash,
        status: 'active',
        lastAccessedAt: now,
        accessCount: Number(raw.accessCount) || 0,
      };
      records.push(record);
      inserted += 1;
    }

    let removedExpired = 0;
    if (opts.runCleanup !== false) {
      const result = enforceActiveCaps(records, { sessionCap, npcCap, now });
      removedExpired = result.removedExpired;
    }

    cleanupStats = {
      lastRunAt: now,
      removedDedupe: cleanupStats.removedDedupe + merged,
      removedExpired: cleanupStats.removedExpired + removedExpired,
      activeCount: activeCount(),
    };

    return { inserted, merged, cleanup: { ...cleanupStats } };
  }

  /**
   * @param {{ k?: number, maxChars?: number, npcId?: string, now?: number }} [opts]
   */
  function retrieve(opts = {}) {
    return retrieveMemories(records, {
      k: opts.k ?? 8,
      maxChars: opts.maxChars ?? 2000,
      npcId: opts.npcId,
      now: opts.now,
    });
  }

  /**
   * @param {{ now?: number }} [opts]
   */
  function cleanup(opts = {}) {
    const now = Number.isFinite(opts.now) ? opts.now : Date.now();
    const result = enforceActiveCaps(records, { sessionCap, npcCap, now });
    cleanupStats = {
      lastRunAt: now,
      removedDedupe: cleanupStats.removedDedupe,
      removedExpired: cleanupStats.removedExpired + result.removedExpired,
      activeCount: result.activeCount,
    };
    return { ...cleanupStats };
  }

  function listActive() {
    return records.filter((r) => r.status === 'active').map((r) => ({ ...r }));
  }

  function getCleanupStats() {
    return { ...cleanupStats, activeCount: activeCount() };
  }

  function clear() {
    records.length = 0;
    cleanupStats = {
      lastRunAt: 0,
      removedDedupe: 0,
      removedExpired: 0,
      activeCount: 0,
    };
  }

  return {
    insertMany,
    retrieve,
    cleanup,
    activeCount,
    listActive,
    getCleanupStats,
    clear,
    /** @internal test helper */
    _records: records,
  };
}
