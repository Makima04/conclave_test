/**
 * HTML markdown fence stripping (port of backend regex_engine.rs
 * strip_markdown_fences / strip_outer_html_fence / looks_like_html).
 *
 * @module st-host/render/HtmlFence
 */

/** Case-insensitive HTML-looking prefixes (trim_start + ascii lower). */
const HTML_PREFIXES = [
  '<!doctype',
  '<html',
  '<head',
  '<body',
  '<style',
  '<script',
  '<div',
  '<section',
  '<article',
  '<main',
]

/**
 * @param {string} text
 * @returns {boolean}
 */
export function looksLikeHtml(text) {
  const trimmed = String(text ?? '')
    .trimStart()
    .toLowerCase()
  return HTML_PREFIXES.some((prefix) => trimmed.startsWith(prefix))
}

/**
 * If the entire trimmed string is a single ``` / ```html fence whose content
 * looks like HTML, return the unwrapped content; otherwise null.
 *
 * @param {string} text
 * @returns {string|null}
 */
export function stripOuterHtmlFence(text) {
  const trimmed = String(text ?? '').trim()
  if (!trimmed.startsWith('```')) return null

  let inner = trimmed.slice(3).replace(/^\s+/, '')
  // Optional `html` language tag (word boundary / whitespace after)
  if (
    inner.length >= 4 &&
    inner.slice(0, 4).toLowerCase() === 'html' &&
    (inner.length === 4 || /\s/.test(inner.charAt(4)))
  ) {
    inner = inner.slice(4).replace(/^\s+/, '')
  }

  const endTrimmed = inner.replace(/\s+$/, '')
  let content
  if (endTrimmed.endsWith('```')) {
    const end = endTrimmed.length - 3
    content = inner.slice(0, end).trim()
  } else {
    content = inner.trim()
  }

  if (looksLikeHtml(content)) return content
  return null
}

/**
 * Prefer outer fence when the whole text is one HTML fence; else replace
 * inner fences whose content looks like HTML.
 *
 * @param {string} text
 * @returns {string}
 */
export function stripHtmlFences(text) {
  if (text == null) return ''
  const asString = String(text)

  const outer = stripOuterHtmlFence(asString)
  if (outer != null) return outer

  // Port of (?is)```\s*(?:html\b)?\s*([\s\S]*?)\s*```
  return asString.replace(/```\s*(?:html\b)?\s*([\s\S]*?)\s*```/gi, (full, content) => {
    if (looksLikeHtml(content)) return String(content).trim()
    return full
  })
}
