/**
 * Normalize + contentHash for MemoryRecord dedupe (§6.3).
 * @module mind/dedupe
 */

/**
 * Lowercase, collapse whitespace, strip simple punctuation.
 * @param {string} text
 * @returns {string}
 */
export function normalizeText(text) {
  return String(text ?? '')
    .toLowerCase()
    .replace(/[.,!?;:'"“”‘’、，。！？；：…—\-–_/\\|()[\]{}<>@#$%^&*+=~`]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Fast stable 64-bit FNV-1a style hex digest (sync; no WebCrypto required).
 * Content-hash identity is what matters for dedupe; algorithm may evolve.
 * @param {string} input
 * @returns {string}
 */
export function hashString(input) {
  const s = String(input ?? '');
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < s.length; i += 1) {
    const c = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193);
    h2 = Math.imul(h2 ^ c, 0x811c9dc5);
  }
  return (
    (h1 >>> 0).toString(16).padStart(8, '0') +
    (h2 >>> 0).toString(16).padStart(8, '0')
  );
}

/**
 * contentHash = hash(npcId + normalize(text))
 * @param {string} npcId
 * @param {string} text
 * @returns {string}
 */
export function contentHash(npcId, text) {
  return hashString(`${String(npcId ?? '')}\0${normalizeText(text)}`);
}
