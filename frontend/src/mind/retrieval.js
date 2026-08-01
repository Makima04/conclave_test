/**
 * Memory retrieval for prompt injection (§6.3).
 * @module mind/retrieval
 */

import { retentionScore } from './cleanup.js';

/**
 * Top-K active memories by retention score, capped by maxChars.
 *
 * @param {import('./types.js').MemoryRecord[]} records
 * @param {{ k?: number, maxChars?: number, now?: number, npcId?: string }} [options]
 * @returns {import('./types.js').MemoryRecord[]}
 */
export function retrieveMemories(records, options = {}) {
  const k = Number.isFinite(options.k) ? options.k : 8;
  const maxChars = Number.isFinite(options.maxChars) ? options.maxChars : 2000;
  const now = Number.isFinite(options.now) ? options.now : Date.now();
  const npcId = options.npcId;

  let candidates = (Array.isArray(records) ? records : []).filter(
    (r) => r && r.status === 'active',
  );
  if (npcId) {
    candidates = candidates.filter((r) => r.npcId === npcId);
  }

  candidates.sort((a, b) => retentionScore(b, now) - retentionScore(a, now));

  /** @type {import('./types.js').MemoryRecord[]} */
  const selected = [];
  let used = 0;
  for (const mem of candidates) {
    if (selected.length >= k) break;
    const len = String(mem.text ?? '').length;
    if (selected.length > 0 && used + len > maxChars) continue;
    selected.push(mem);
    used += len;
    mem.lastAccessedAt = now;
    mem.accessCount = (Number(mem.accessCount) || 0) + 1;
  }
  return selected;
}
