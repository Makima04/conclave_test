/**
 * Rule-based memory extractor (architecture §6.2.1).
 * No LLM; pure heuristics over recent transcript messages.
 *
 * @module mind/RuleExtractor
 */

import { contentHash, normalizeText } from './dedupe.js';

export const EXTRACT_WINDOW_K = 6;
export const EXTRACT_MAX_CANDIDATES = 3;
export const EXTRACT_MAX_TEXT = 200;
export const EXTRACT_MIN_TEXT = 8;

/**
 * UI chrome / HTML / StatusPlaceHolder / _.set dumps should not become memories.
 * @param {string} text
 * @returns {boolean}
 */
export function looksLikeUiChrome(text) {
  const t = String(text ?? '');
  if (!t.trim()) return true;
  if (/StatusPlaceHolder/i.test(t)) return true;
  if (/_\.set\s*\(/.test(t)) return true;
  if (/<\/?[a-zA-Z][!/?]?[\w:-]*/.test(t)) return true;
  if (/<initvar/i.test(t) || /<\/?updatevariable/i.test(t)) return true;
  if (/<\/?inner\b/i.test(t)) return true;
  // pure JSON-ish dumps
  if (/^\s*[{[]/.test(t) && /[}\]]\s*$/.test(t) && t.includes(':')) return true;
  return false;
}

/**
 * Prefer lines that look like they mention entities / proper names.
 * @param {string} text
 * @returns {number} higher = better
 */
export function nameHintScore(text) {
  const t = String(text ?? '');
  let score = 0;
  // Latin Capitalized words
  if (/\b[A-Z][a-z]{1,}\b/.test(t)) score += 2;
  // Chinese-ish name run (2–4 CJK)
  if (/[\u4e00-\u9fff]{2,4}/.test(t)) score += 2;
  // quoted names
  if (/[「『"“][^」』"”]{1,12}[」』"”]/.test(t)) score += 1;
  // knowledge verbs / relation cues
  if (/(知道|记得|告诉|认识|met|knows|remember|told)/i.test(t)) score += 1;
  return score;
}

/**
 * Split raw message into candidate lines (newline / 。 / .).
 * @param {string} message
 * @returns {string[]}
 */
export function splitCandidateLines(message) {
  const raw = String(message ?? '');
  return raw
    .split(/\n+|。|\.(?=\s|$)/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Extract up to N memory candidates from the last K transcript messages.
 *
 * @param {Array<{ role?: string, message?: string, message_id?: number }>} messages
 * @param {{ id: string, displayName?: string }} npc
 * @param {{
 *   k?: number,
 *   maxCandidates?: number,
 *   maxText?: number,
 *   minText?: number,
 *   sessionId?: string,
 *   now?: number,
 *   sourceMessageId?: number,
 * }} [options]
 * @returns {import('./types.js').MemoryRecord[]}
 */
export function extractCandidates(messages, npc, options = {}) {
  const k = Number.isFinite(options.k) ? options.k : EXTRACT_WINDOW_K;
  const maxN = Number.isFinite(options.maxCandidates)
    ? options.maxCandidates
    : EXTRACT_MAX_CANDIDATES;
  const maxText = Number.isFinite(options.maxText) ? options.maxText : EXTRACT_MAX_TEXT;
  const minText = Number.isFinite(options.minText) ? options.minText : EXTRACT_MIN_TEXT;
  const now = Number.isFinite(options.now) ? options.now : Date.now();
  const sessionId = options.sessionId != null ? String(options.sessionId) : '0';
  const npcId = npc?.id != null ? String(npc.id) : 'primary';

  const list = Array.isArray(messages) ? messages : [];
  const window = list.slice(-k);

  /** @type {{ text: string, sourceMessageId: number|undefined, hint: number, length: number }[]} */
  const blobs = [];

  for (const m of window) {
    const role = m?.role;
    if (role !== 'user' && role !== 'assistant') continue;
    const lines = splitCandidateLines(m.message);
    for (const line of lines) {
      const t = line.trim();
      if (t.length < minText || t.length > maxText) continue;
      if (looksLikeUiChrome(t)) continue;
      blobs.push({
        text: t,
        sourceMessageId:
          options.sourceMessageId != null
            ? Number(options.sourceMessageId)
            : Number.isFinite(m.message_id)
              ? Number(m.message_id)
              : undefined,
        hint: nameHintScore(t),
        length: t.length,
      });
    }
  }

  blobs.sort((a, b) => {
    if (b.hint !== a.hint) return b.hint - a.hint;
    return b.length - a.length;
  });

  // Dedupe within this turn by normalize
  const seen = new Set();
  /** @type {import('./types.js').MemoryRecord[]} */
  const out = [];
  for (const blob of blobs) {
    if (out.length >= maxN) break;
    const norm = normalizeText(blob.text);
    if (!norm || seen.has(norm)) continue;
    seen.add(norm);
    const hash = contentHash(npcId, blob.text);
    out.push({
      id: `mem_${hash.slice(0, 12)}_${now.toString(36)}`,
      npcId,
      sessionId,
      createdAt: now,
      updatedAt: now,
      sourceMessageId: blob.sourceMessageId,
      text: blob.text.slice(0, maxText),
      labels: ['knowledge/unspecified'],
      scores: { knowledge: 0.5 },
      contentHash: hash,
      status: 'active',
      lastAccessedAt: now,
      accessCount: 0,
    });
  }
  return out;
}
