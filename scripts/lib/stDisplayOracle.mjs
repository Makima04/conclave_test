/**
 * SillyTavern-aligned display oracle (pure, scripts-as-input).
 *
 * Mirrors ST `public/scripts/extensions/regex/engine.js`:
 *   getRegexedString(raw, placement, { isMarkdown, isPrompt, isEdit, depth })
 * when scripts are supplied explicitly (Conclave has no extension_settings).
 *
 * Placement enums match ST regex_placement.
 * Empty placement array → skip script (ST: script.placement.includes fails).
 *
 * This is the golden generator for Conclave FE `processDisplay` / `getRegexedString`.
 * Full ST runtime (extension_settings, character macros) is NOT loaded here.
 *
 * @module scripts/lib/stDisplayOracle
 */

export const regex_placement = {
  MD_DISPLAY: 0,
  USER_INPUT: 1,
  AI_OUTPUT: 2,
  SLASH_COMMAND: 3,
  WORLD_INFO: 5,
  REASONING: 6,
}

/**
 * @param {string} findRegex
 * @returns {{ source: string, flags: string } | null}
 */
function parseFindRegex(findRegex) {
  if (findRegex == null) return null
  const raw = String(findRegex).trim()
  if (!raw) return null
  let source
  let flagStr = ''
  if (raw.startsWith('/')) {
    const rest = raw.slice(1)
    const last = rest.lastIndexOf('/')
    if (last >= 0) {
      source = rest.slice(0, last)
      flagStr = rest.slice(last + 1)
    } else {
      source = rest
    }
  } else {
    source = raw
  }
  const allowed = new Set(['g', 'i', 'm', 's', 'u', 'y', 'd', 'v'])
  let flags = ''
  for (const ch of flagStr) {
    const c = ch.toLowerCase()
    if (allowed.has(c) && !flags.includes(c)) flags += c
  }
  if (!flags.includes('g')) flags += 'g'
  try {
    void new RegExp(source, flags)
    return { source, flags }
  } catch {
    return null
  }
}

/**
 * Expand `$n` replacements like ST / Rust (not `$&` name collisions).
 * @param {string} template
 * @param {RegExpMatchArray} match
 */
function expandReplacement(template, match) {
  return String(template).replace(/\$(\d{1,2})/g, (_, n) => {
    const idx = Number(n)
    if (Number.isFinite(idx) && match[idx] != null) return match[idx]
    return `$${n}`
  })
}

/**
 * ST runRegexScript (simplified: no macro substitute path when substituteRegex=0).
 * @param {object} script
 * @param {string} rawString
 */
export function runRegexScript(script, rawString) {
  if (!script || script.disabled || !script.findRegex || !rawString) return rawString
  const parsed = parseFindRegex(script.findRegex)
  if (!parsed) return rawString
  let out = rawString
  try {
    const re = new RegExp(parsed.source, parsed.flags)
    out = rawString.replace(re, (...args) => {
      // last two args are offset, string; named groups may follow in modern engines
      const match = args.slice(0, -2)
      match.index = args[args.length - 2]
      match.input = args[args.length - 1]
      match[0] = args[0]
      for (let i = 1; i < args.length - 2; i++) match[i] = args[i]
      return expandReplacement(script.replaceString ?? '', match)
    })
  } catch {
    return rawString
  }
  return out
}

/**
 * ST getRegexedString with explicit scripts array.
 *
 * @param {string} rawString
 * @param {number} placement
 * @param {{ isMarkdown?: boolean, isPrompt?: boolean, isEdit?: boolean, depth?: number }} [params]
 * @param {object[]} scripts
 * @returns {string}
 */
export function getRegexedString(rawString, placement, params = {}, scripts = []) {
  if (typeof rawString !== 'string') return ''
  let finalString = rawString
  if (!rawString || placement === undefined) return finalString

  const { isMarkdown = false, isPrompt = false, isEdit = false, depth } = params
  const list = Array.isArray(scripts) ? scripts : []

  for (const script of list) {
    if (!script) continue
    const md = !!script.markdownOnly
    const po = !!script.promptOnly
    const applies =
      (md && isMarkdown) ||
      (po && isPrompt) ||
      (!md && !po && !isMarkdown && !isPrompt)
    if (!applies) continue
    if (isEdit && !script.runOnEdit) continue

    if (typeof depth === 'number') {
      const minD = script.minDepth
      const maxD = script.maxDepth
      if (minD != null && !Number.isNaN(Number(minD)) && Number(minD) >= -1 && depth < Number(minD)) {
        continue
      }
      if (maxD != null && !Number.isNaN(Number(maxD)) && Number(maxD) >= 0 && depth > Number(maxD)) {
        continue
      }
    }

    const placementArr = Array.isArray(script.placement) ? script.placement : []
    // ST: empty placement → includes fails → skip
    if (!placementArr.map(Number).includes(Number(placement))) continue

    finalString = runRegexScript(script, finalString)
  }
  return finalString
}

const STATUS_PLACEHOLDER = '<StatusPlaceHolderImpl/>'

function messageHasStatusVariablePayload(message) {
  const lower = String(message ?? '').toLowerCase()
  return lower.includes('<initvar') || lower.includes('<updatevariable')
}

function appendStatusPlaceholderIfNeeded(message, scripts, { hasTavernHelperScripts } = {}) {
  const text = message == null ? '' : String(message)
  if (text.includes(STATUS_PLACEHOLDER) || hasTavernHelperScripts) return text
  if (!messageHasStatusVariablePayload(text)) return text
  const list = Array.isArray(scripts) ? scripts : []
  const hasBar = list.some(
    (s) =>
      s &&
      !s.disabled &&
      s.markdownOnly &&
      String(s.findRegex ?? '').trim() === STATUS_PLACEHOLDER &&
      String(s.replaceString ?? '').trim() !== '',
  )
  return hasBar ? `${text}\n${STATUS_PLACEHOLDER}` : text
}

/** Port of frontend HtmlFence.stripHtmlFences (do not invent extra stripping). */
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

function looksLikeHtml(text) {
  const trimmed = String(text ?? '')
    .trimStart()
    .toLowerCase()
  return HTML_PREFIXES.some((prefix) => trimmed.startsWith(prefix))
}

function stripOuterHtmlFence(text) {
  const trimmed = String(text ?? '').trim()
  if (!trimmed.startsWith('```')) return null
  let inner = trimmed.slice(3).replace(/^\s+/, '')
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
    content = inner.slice(0, endTrimmed.length - 3).trim()
  } else {
    content = inner.trim()
  }
  if (looksLikeHtml(content)) return content
  return null
}

function stripHtmlFences(text) {
  if (text == null) return ''
  const asString = String(text)
  const outer = stripOuterHtmlFence(asString)
  if (outer != null) return outer
  return asString.replace(/```\s*(?:html\b)?\s*([\s\S]*?)\s*```/gi, (full, content) => {
    if (looksLikeHtml(content)) return String(content).trim()
    return full
  })
}

/**
 * Full Conclave/ST-aligned display pipeline (oracle for goldens).
 *
 * @param {string} raw
 * @param {object[]} scripts
 * @param {{ placement?: number, depth?: number, isEdit?: boolean, hasTavernHelperScripts?: boolean }} [options]
 */
export function processDisplayOracle(raw, scripts, options = {}) {
  const placement = options.placement ?? regex_placement.AI_OUTPUT
  const { depth, isEdit = false, hasTavernHelperScripts = false } = options
  let text = raw == null ? '' : String(raw)
  text = appendStatusPlaceholderIfNeeded(text, scripts, { hasTavernHelperScripts })
  text = getRegexedString(text, placement, { isMarkdown: false, isPrompt: false, isEdit, depth }, scripts)
  text = getRegexedString(text, placement, { isMarkdown: true, isPrompt: false, isEdit, depth }, scripts)
  text = stripHtmlFences(text)
  return text
}
