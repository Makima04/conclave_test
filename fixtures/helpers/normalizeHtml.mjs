/**
 * Normalize HTML/text for stable golden comparison.
 * Strips volatile whitespace differences without changing tag structure.
 *
 * @param {string} input
 * @returns {string}
 */
export function normalizeHtml(input) {
  let s = input == null ? '' : String(input)
  // Normalize newlines
  s = s.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
  // Collapse runs of spaces/tabs (not newlines)
  s = s.replace(/[ \t]+/g, ' ')
  // Trim spaces around newlines
  s = s.replace(/ *\n */g, '\n')
  // Collapse 3+ blank lines
  s = s.replace(/\n{3,}/g, '\n\n')
  return s.trim()
}

/**
 * Extract a coarse DOM-contract fingerprint (ids/classes present).
 * Useful when full HTML is too brittle but structure must hold.
 *
 * @param {string} html
 * @returns {{ ids: string[], classes: string[], hasStatusCard: boolean }}
 */
export function htmlFingerprint(html) {
  const s = html == null ? '' : String(html)
  const ids = [...s.matchAll(/\bid=["']([^"']+)["']/g)].map((m) => m[1]).sort()
  const classes = [...s.matchAll(/\bclass=["']([^"']+)["']/g)]
    .flatMap((m) => m[1].split(/\s+/).filter(Boolean))
    .sort()
  return {
    ids,
    classes,
    hasStatusCard: /status-card|id=["']status-card["']/.test(s),
  }
}
