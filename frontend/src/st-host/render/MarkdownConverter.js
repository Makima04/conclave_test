/**
 * ST-aligned display markdown → HTML (showdown).
 *
 * Source of truth: SillyTavern `reloadMarkdownProcessor` / `converter.makeHtml`
 * (public/script.js) — options: simpleLineBreaks, tables, strikethrough, etc.
 *
 * Applied after regex + fence strip so plain narrative gets `<br>` / `<p>`,
 * while card HTML injections generally pass through.
 *
 * @module st-host/render/MarkdownConverter
 */

import Showdown from 'showdown'

/** @type {Showdown.Converter|null} */
let converter = null

/**
 * Feature flag: localStorage `conclave:feature:display_markdown` !== '0' (default ON).
 * @param {{ storage?: Storage|null }} [opts]
 * @returns {boolean}
 */
export function isDisplayMarkdownEnabled(opts = {}) {
  try {
    const storage =
      opts.storage !== undefined
        ? opts.storage
        : typeof globalThis !== 'undefined'
          ? globalThis.localStorage
          : null
    if (!storage || typeof storage.getItem !== 'function') return true
    return storage.getItem('conclave:feature:display_markdown') !== '0'
  } catch {
    return true
  }
}

/**
 * Build (or return cached) showdown converter with ST-like options.
 * @returns {Showdown.Converter}
 */
export function getMarkdownConverter() {
  if (converter) return converter
  converter = new Showdown.Converter({
    emoji: true,
    literalMidWordUnderscores: true,
    parseImgDimensions: true,
    tables: true,
    underline: true,
    simpleLineBreaks: true,
    strikethrough: true,
    disableForced4SpacesIndentedSublists: true,
  })
  return converter
}

/** Reset cached converter (tests). */
export function resetMarkdownConverter() {
  converter = null
}

/**
 * True when the whole trimmed string looks like a full HTML document / heavy
 * card shell — running showdown would still usually pass tags through, but we
 * skip to avoid accidental wrapping of large UI payloads.
 *
 * @param {string} text
 * @returns {boolean}
 */
export function shouldSkipMarkdown(text) {
  const t = String(text ?? '').trimStart().toLowerCase()
  if (!t) return true
  if (t.startsWith('<!doctype') || t.startsWith('<html')) return true
  // Entire message is a single style/script-heavy block with no prose to break.
  if (
    (t.startsWith('<style') || t.startsWith('<script')) &&
    !/\n\s*\n/.test(String(text ?? ''))
  ) {
    return true
  }
  return false
}

/**
 * Convert display text to HTML (ST `converter.makeHtml` step).
 *
 * @param {string} text
 * @param {{ enabled?: boolean }} [options]
 * @returns {string}
 */
export function makeDisplayHtml(text, options = {}) {
  if (text == null) return ''
  const raw = String(text)
  if (!raw) return ''

  const enabled =
    options.enabled !== undefined ? !!options.enabled : isDisplayMarkdownEnabled()
  if (!enabled) return raw
  if (shouldSkipMarkdown(raw)) return raw

  try {
    return getMarkdownConverter().makeHtml(raw)
  } catch (err) {
    console.warn('[MarkdownConverter] makeHtml failed, returning raw:', err)
    return raw
  }
}
