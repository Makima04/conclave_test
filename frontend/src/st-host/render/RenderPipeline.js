/**
 * Display RenderPipeline (architecture-host-mind.md §5.2).
 *
 * raw → StatusPlaceHolder? → getRegexedString (source) → getRegexedString (markdown)
 *     → stripHtmlFences
 *
 * @module st-host/render/RenderPipeline
 */

import { stripHtmlFences } from './HtmlFence.js'
import { getRegexedString, regex_placement } from './RegexEngine.js'

export const STATUS_PLACEHOLDER = '<StatusPlaceHolderImpl/>'

const FEATURE_KEY = 'conclave:feature:display_regex_fe'

/**
 * True when message carries initvar / UpdateVariable payloads (case insensitive).
 *
 * @param {string} message
 * @returns {boolean}
 */
export function messageHasStatusVariablePayload(message) {
  const lower = String(message ?? '').toLowerCase()
  return lower.includes('<initvar') || lower.includes('<updatevariable')
}

/**
 * Port of backend append_card_status_placeholder_if_needed (main.rs).
 *
 * @param {string} message
 * @param {import('./RegexEngine.js').RegexScript[]} scripts
 * @param {{ hasTavernHelperScripts?: boolean }} [options]
 * @returns {string}
 */
export function appendStatusPlaceholderIfNeeded(message, scripts, { hasTavernHelperScripts } = {}) {
  const text = message == null ? '' : String(message)

  if (text.includes(STATUS_PLACEHOLDER) || hasTavernHelperScripts) {
    return text
  }

  if (!messageHasStatusVariablePayload(text)) {
    return text
  }

  const list = Array.isArray(scripts) ? scripts : []
  const hasCardStatusbarRegex = list.some(
    (script) =>
      script &&
      !script.disabled &&
      script.markdownOnly &&
      String(script.findRegex ?? '').trim() === STATUS_PLACEHOLDER &&
      String(script.replaceString ?? '').trim() !== '',
  )

  if (hasCardStatusbarRegex) {
    return `${text}\n${STATUS_PLACEHOLDER}`
  }
  return text
}

/**
 * Full display pipeline (frontend authority).
 *
 * @param {string} raw
 * @param {import('./RegexEngine.js').RegexScript[]} scripts
 * @param {{
 *   placement?: number,
 *   depth?: number,
 *   isEdit?: boolean,
 *   hasTavernHelperScripts?: boolean,
 *   featureFlag?: boolean,
 * }} [options]
 * @returns {string}
 */
export function processDisplay(raw, scripts, options = {}) {
  const {
    placement = regex_placement.AI_OUTPUT,
    depth,
    isEdit = false,
    hasTavernHelperScripts = false,
  } = options

  let text = raw == null ? '' : String(raw)
  text = appendStatusPlaceholderIfNeeded(text, scripts, { hasTavernHelperScripts })
  text = getRegexedString(
    text,
    placement,
    { isMarkdown: false, isPrompt: false, isEdit, depth },
    scripts,
  )
  text = getRegexedString(
    text,
    placement,
    { isMarkdown: true, isPrompt: false, isEdit, depth },
    scripts,
  )
  text = stripHtmlFences(text)
  return text
}

/**
 * Feature flag: localStorage `conclave:feature:display_regex_fe` !== '0' (default ON).
 *
 * @returns {boolean}
 */
export function isDisplayRegexFeEnabled() {
  try {
    if (typeof globalThis === 'undefined') return true
    const storage = globalThis.localStorage
    if (!storage || typeof storage.getItem !== 'function') return true
    return storage.getItem(FEATURE_KEY) !== '0'
  } catch {
    return true
  }
}
