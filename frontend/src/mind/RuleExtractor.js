/**
 * Rule-based memory extractor (architecture §6.2.1 + PR-12 tuning).
 * No LLM; pure heuristics over recent transcript messages.
 *
 * @module mind/RuleExtractor
 */

import { contentHash, normalizeText } from './dedupe.js';

export const EXTRACT_WINDOW_K = 6;
export const EXTRACT_MAX_CANDIDATES = 3;
export const EXTRACT_MAX_TEXT = 200;
export const EXTRACT_MIN_TEXT = 8;
/** Jaccard / containment threshold for within-turn near-duplicate skip. */
export const NEAR_DUP_THRESHOLD = 0.82;

/**
 * UI chrome / HTML / StatusPlaceHolder / _.set dumps should not become memories.
 * PR-12: broader ST / card chrome patterns (script fences, CSS, pure symbols, etc.).
 * @param {string} text
 * @returns {boolean}
 */
export function looksLikeUiChrome(text) {
  const t = String(text ?? '');
  const trimmed = t.trim();
  if (!trimmed) return true;

  // ST / MVU / placeholder dumps
  if (/StatusPlaceHolder/i.test(t)) return true;
  if (/_\.set\s*\(/.test(t)) return true;
  if (/<initvar/i.test(t) || /<\/?updatevariable/i.test(t)) return true;
  if (/<\/?inner\b/i.test(t)) return true;
  if (/\bstat_data\b/i.test(t) && /[{[]/.test(t)) return true;

  // HTML / script / style / template tags (any residual markup)
  if (/<\/?[a-zA-Z][!/?]?[\w:-]*/.test(t)) return true;
  if (/&(?:lt|gt|amp|quot|nbsp);/i.test(t) && /[<>]/.test(t.replace(/&(?:lt|gt);/gi, '<>'))) {
    return true;
  }

  // pure JSON-ish dumps
  if (/^\s*[{[]/.test(trimmed) && /[}\]]\s*$/.test(trimmed) && trimmed.includes(':')) {
    return true;
  }

  // CSS rule-ish / selector dumps
  if (/[{;]\s*[\w-]+\s*:\s*[^;]+;/.test(t) && /[{}]/.test(t)) return true;

  // code fences / ES module import-export (code-shaped only — not narrative "import silk")
  if (/```/.test(t)) return true;
  if (
    /^\s*import\s+(?:(?:[\w*{}$,\s]+)\s+from\s+)?['"]/.test(trimmed) ||
    /^\s*import\s*[{*]/.test(trimmed) ||
    /^\s*export\s+(?:default\s+)?(?:\{|function|class|const|let|var|\*)/.test(trimmed)
  ) {
    return true;
  }
  // data URIs
  if (/data:[a-z]+\/[a-z0-9.+-]+;base64,/i.test(t)) return true;

  // mostly non-letter (UI glyphs, separators, raw ids)
  const letters = (trimmed.match(/[\p{L}\p{N}]/gu) || []).length;
  if (letters < 4) return true;
  if (letters / trimmed.length < 0.35 && trimmed.length > 12) return true;

  // pure URL / path chrome
  if (/^https?:\/\//i.test(trimmed) || /^\/[\w./-]+$/.test(trimmed)) return true;

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
  if (/(知道|记得|告诉|认识|遇到|喜欢|讨厌|met|knows|remember|told|likes|hates)/i.test(t)) {
    score += 1;
  }
  return score;
}

/**
 * Split raw message into candidate sentences (CJK + English).
 * Breaks on newlines, Chinese 。！？；…, and English .!?; (avoid common abbreviations).
 * @param {string} message
 * @returns {string[]}
 */
export function splitCandidateLines(message) {
  const raw = String(message ?? '');
  if (!raw.trim()) return [];

  // Normalize common CJK punctuation variants, then split.
  // English period: require following whitespace/end OR CJK boundary (avoid "Mr. X" lightly).
  const parts = raw
    .replace(/\r\n?/g, '\n')
    .split(
      /\n+|。|！|？|；|…+|(?<![A-Za-z])\.(?=\s|$|[\u4e00-\u9fff])|[!?;](?=\s|$|[\u4e00-\u9fff])/,
    )
    .map((s) => s.trim())
    .filter(Boolean);

  return parts;
}

/**
 * Tokenize for near-duplicate comparison (CJK unigrams + latin words).
 * @param {string} text
 * @returns {string[]}
 */
export function tokenizeForSimilarity(text) {
  const norm = normalizeText(text);
  if (!norm) return [];
  /** @type {string[]} */
  const tokens = [];
  // Latin/number runs
  for (const m of norm.matchAll(/[a-z0-9]+/g)) {
    if (m[0].length >= 2) tokens.push(m[0]);
  }
  // CJK chars as unigrams (after normalize punctuation is already gone)
  for (const m of norm.matchAll(/[\u4e00-\u9fff]/g)) {
    tokens.push(m[0]);
  }
  return tokens;
}

/**
 * Jaccard similarity on token sets; empty → 0.
 * @param {string} a
 * @param {string} b
 * @returns {number}
 */
export function textSimilarity(a, b) {
  const ta = tokenizeForSimilarity(a);
  const tb = tokenizeForSimilarity(b);
  if (!ta.length || !tb.length) return 0;
  const setA = new Set(ta);
  const setB = new Set(tb);
  let inter = 0;
  for (const t of setA) {
    if (setB.has(t)) inter += 1;
  }
  const union = setA.size + setB.size - inter;
  if (union <= 0) return 0;
  const jaccard = inter / union;
  // Also consider containment of the shorter set (near-substring duplicates).
  const smaller = Math.min(setA.size, setB.size);
  const containment = smaller > 0 ? inter / smaller : 0;
  return Math.max(jaccard, containment * 0.95);
}

/**
 * True if `text` is a near-duplicate of any already accepted texts.
 * @param {string} text
 * @param {string[]} accepted
 * @param {number} [threshold]
 * @returns {boolean}
 */
export function isNearDuplicateOfAny(text, accepted, threshold = NEAR_DUP_THRESHOLD) {
  const list = Array.isArray(accepted) ? accepted : [];
  for (const other of list) {
    if (normalizeText(text) === normalizeText(other)) return true;
    if (textSimilarity(text, other) >= threshold) return true;
  }
  return false;
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
 *   nearDupThreshold?: number,
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
  const nearDupThreshold = Number.isFinite(options.nearDupThreshold)
    ? options.nearDupThreshold
    : NEAR_DUP_THRESHOLD;
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

  // Exact normalize + near-duplicate skip within this turn
  const seenExact = new Set();
  /** @type {string[]} */
  const acceptedTexts = [];
  /** @type {import('./types.js').MemoryRecord[]} */
  const out = [];
  for (const blob of blobs) {
    if (out.length >= maxN) break;
    const norm = normalizeText(blob.text);
    if (!norm || seenExact.has(norm)) continue;
    if (isNearDuplicateOfAny(blob.text, acceptedTexts, nearDupThreshold)) continue;
    seenExact.add(norm);
    acceptedTexts.push(blob.text);
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
