/**
 * Display RenderPipeline (architecture-host-mind.md §5.2).
 *
 * raw → substituteParams → StatusPlaceHolder? → getRegexedString (source)
 *     → getRegexedString (markdown) → stripHtmlFences → makeDisplayHtml
 *
 * Aligns with ST messageFormatting order (macros → regex → showdown.makeHtml),
 * plus Conclave fence strip for card ```html openings.
 *
 * @module st-host/render/RenderPipeline
 */

import { stripHtmlFences } from './HtmlFence.js'
import { makeDisplayHtml } from './MarkdownConverter.js'
import {
  getRegexedString,
  regex_placement,
  substituteBasicParams,
} from './RegexEngine.js'

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
 * Inject when the card has a non-empty markdownOnly StatusPlaceHolder regex
 * (e.g. 变身少女「状态栏美化」). Do **not** skip just because the card also has
 * TavernHelper scripts — TH is often MVU/小手机, not the statusbar provider.
 * Cards that use remote TH statusbars (e.g. 苍玄) keep an empty replaceString on
 * their StatusPlaceHolder script, so hasCardStatusbarRegex stays false.
 *
 * @param {string} message
 * @param {import('./RegexEngine.js').RegexScript[]} scripts
 * @param {{ hasTavernHelperScripts?: boolean }} [options] kept for API compat; ignored
 * @returns {string}
 */
export function appendStatusPlaceholderIfNeeded(message, scripts, _options = {}) {
  const text = message == null ? '' : String(message)

  if (text.includes(STATUS_PLACEHOLDER)) {
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
 *   userName?: string,
 *   characterOverride?: string,
 *   charName?: string,
 *   macros?: Record<string, string>,
 *   substituteMacros?: boolean,
 *   markdown?: boolean,
 * }} [options]
 * @returns {string}
 */
export function processDisplay(raw, scripts, options = {}) {
  const {
    placement = regex_placement.AI_OUTPUT,
    depth,
    isEdit = false,
    hasTavernHelperScripts = false,
    userName,
    characterOverride,
    charName,
    macros,
    substituteMacros = true,
    markdown = true,
  } = options

  let text = raw == null ? '' : String(raw)

  // ST messageFormatting: substituteParams before regex (opening always;
  // Conclave applies on every display so AI-emitted {{user}} also expands).
  if (substituteMacros) {
    text = substituteBasicParams(text, {
      userName: userName != null ? String(userName) : 'User',
      characterOverride:
        characterOverride != null
          ? String(characterOverride)
          : charName != null
            ? String(charName)
            : '',
      macros,
    })
  }

  text = appendStatusPlaceholderIfNeeded(text, scripts, { hasTavernHelperScripts })
  text = getRegexedString(
    text,
    placement,
    {
      isMarkdown: false,
      isPrompt: false,
      isEdit,
      depth,
      characterOverride: characterOverride ?? charName,
      userName,
    },
    scripts,
  )
  text = getRegexedString(
    text,
    placement,
    {
      isMarkdown: true,
      isPrompt: false,
      isEdit,
      depth,
      characterOverride: characterOverride ?? charName,
      userName,
    },
    scripts,
  )
  text = stripHtmlFences(text)

  // ST converter.makeHtml — newlines → <br>/<p>; HTML from regex mostly preserved.
  if (markdown) {
    text = makeDisplayHtml(text)
  }

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
