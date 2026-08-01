/**
 * Display-side regex engine aligned with SillyTavern getRegexedString rules
 * and Rust expand_replacement ($n golden).
 *
 * @module st-host/render/RegexEngine
 */

/** @see SillyTavern public/scripts/extensions/regex/engine.js regex_placement */
export const regex_placement = {
  MD_DISPLAY: 0,
  USER_INPUT: 1,
  AI_OUTPUT: 2,
  SLASH_COMMAND: 3,
  WORLD_INFO: 5,
  REASONING: 6,
}

/**
 * @typedef {Object} RegexScript
 * @property {string} [id]
 * @property {string} [scriptName]
 * @property {string} findRegex
 * @property {string} replaceString
 * @property {number[]} [placement]
 * @property {boolean} [disabled]
 * @property {boolean} [markdownOnly]
 * @property {boolean} [promptOnly]
 * @property {boolean} [runOnEdit]
 * @property {number|null} [minDepth]
 * @property {number|null} [maxDepth]
 * @property {number} [substituteRegex]  // warn only if non-zero for P1
 */

/** @type {Set<string>} */
const substituteWarnedIds = new Set()

/**
 * Parse ST-style `/pattern/flags` or bare pattern into JS RegExp parts.
 * Always ensures `g` so display replaces all matches (Rust replace_all).
 *
 * @param {string} findRegex
 * @returns {{ source: string, flags: string } | null}
 */
export function parseFindRegex(findRegex) {
  if (findRegex == null) return null
  const raw = String(findRegex).trim()
  if (!raw) return null

  let source
  let flagStr = ''

  if (raw.startsWith('/')) {
    const withoutLeading = raw.slice(1)
    const lastSlash = withoutLeading.lastIndexOf('/')
    if (lastSlash >= 0) {
      source = withoutLeading.slice(0, lastSlash)
      flagStr = withoutLeading.slice(lastSlash + 1)
    } else {
      source = withoutLeading
    }
  } else {
    source = raw
  }

  // Map ST flags; JS uses a flags string (not (?m) prefixes like Rust).
  const allowed = new Set(['g', 'i', 'm', 's', 'u', 'y', 'd', 'v'])
  let flags = ''
  for (const ch of flagStr) {
    const c = ch.toLowerCase()
    if (allowed.has(c) && !flags.includes(c)) flags += c
  }
  if (!flags.includes('g')) flags += 'g'

  try {
    // Validate constructibility
    void new RegExp(source, flags)
    return { source, flags }
  } catch {
    return null
  }
}

/**
 * Rust-compatible `$` expansion: `$$`, `$&`, `$1`–`$99` (two-digit only when
 * that group exists), `${name}` named groups. Bare `$fabao…` stays `$` + rest.
 *
 * @param {string} template
 * @param {string} match  full match ($&)
 * @param {Array<string|undefined>} groups  $1.. at indices 0..
 * @param {Record<string, string>|undefined|null} namedGroups
 * @returns {string}
 */
export function expandReplacement(template, match, groups = [], namedGroups = undefined) {
  const tpl = template == null ? '' : String(template)
  const full = match == null ? '' : String(match)
  const captureCount = Array.isArray(groups) ? groups.length : 0

  let output = ''
  let i = 0
  while (i < tpl.length) {
    const ch = tpl[i]
    if (ch !== '$') {
      output += ch
      i += 1
      continue
    }

    const next = tpl[i + 1]
    if (next === undefined) {
      output += '$'
      i += 1
      continue
    }

    if (next === '$') {
      output += '$'
      i += 2
      continue
    }

    if (next === '&') {
      output += full
      i += 2
      continue
    }

    if (next >= '1' && next <= '9') {
      const firstDigit = next
      const firstIndex = Number(firstDigit)
      const second = tpl[i + 2]
      if (second !== undefined && second >= '0' && second <= '9') {
        const twoDigitIndex = firstIndex * 10 + Number(second)
        if (twoDigitIndex <= captureCount) {
          const g = groups[twoDigitIndex - 1]
          output += g == null ? '' : String(g)
          i += 3
          continue
        }
      }
      if (firstIndex <= captureCount) {
        const g = groups[firstIndex - 1]
        output += g == null ? '' : String(g)
        i += 2
      } else {
        output += '$'
        output += firstDigit
        i += 2
      }
      continue
    }

    if (next === '{') {
      i += 2 // skip ${
      let name = ''
      let closed = false
      while (i < tpl.length) {
        const c = tpl[i]
        i += 1
        if (c === '}') {
          closed = true
          break
        }
        name += c
      }
      if (closed) {
        if (namedGroups && Object.prototype.hasOwnProperty.call(namedGroups, name)) {
          const v = namedGroups[name]
          output += v == null ? '' : String(v)
        } else {
          output += '${'
          output += name
          output += '}'
        }
      } else {
        output += '${'
        output += name
      }
      continue
    }

    // `$` followed by non-special (e.g. `$fabaoGrid`) — keep `$` and continue
    output += '$'
    i += 1
  }

  return output
}

/**
 * ST engine.js:334-380 filter rules.
 *
 * @param {RegexScript} script
 * @param {{ isMarkdown?: boolean, isPrompt?: boolean, isEdit?: boolean, depth?: number, placement?: number }} ctx
 * @returns {boolean}
 */
export function shouldRunScript(
  script,
  { isMarkdown = false, isPrompt = false, isEdit = false, depth, placement } = {},
) {
  if (!script || script.disabled) return false

  const markdownOnly = !!script.markdownOnly
  const promptOnly = !!script.promptOnly

  // Stage branch (ST): markdownOnly+isMarkdown OR promptOnly+isPrompt OR neither-only on source stage
  const stageOk =
    (markdownOnly && isMarkdown) ||
    (promptOnly && isPrompt) ||
    (!markdownOnly && !promptOnly && !isMarkdown && !isPrompt)
  if (!stageOk) return false

  if (isEdit && !script.runOnEdit) return false

  if (typeof depth === 'number') {
    const minDepth = script.minDepth
    if (
      minDepth != null &&
      !Number.isNaN(Number(minDepth)) &&
      Number(minDepth) >= -1 &&
      depth < Number(minDepth)
    ) {
      return false
    }
    const maxDepth = script.maxDepth
    if (
      maxDepth != null &&
      !Number.isNaN(Number(maxDepth)) &&
      Number(maxDepth) >= 0 &&
      depth > Number(maxDepth)
    ) {
      return false
    }
  }

  // Empty placement array → skip (ST); non-empty must include placement
  const pl = script.placement
  if (!Array.isArray(pl) || pl.length === 0) return false
  if (!pl.includes(placement)) return false

  // P1: substituteRegex macros not implemented — warn once per script id
  if (script.substituteRegex != null && Number(script.substituteRegex) !== 0) {
    const warnKey = String(script.id || script.scriptName || script.findRegex || '?')
    if (!substituteWarnedIds.has(warnKey)) {
      substituteWarnedIds.add(warnKey)
      console.warn(
        `[ConclaveSTHost] substituteRegex=${script.substituteRegex} not implemented for P1 (script: ${warnKey})`,
      )
    }
  }

  return true
}

/**
 * Run a single regex script. Maps `{{match}}` → full match (ST) via `$&`.
 *
 * @param {RegexScript} script
 * @param {string} rawString
 * @returns {string}
 */
export function runRegexScript(script, rawString) {
  if (!script || script.disabled || !script.findRegex || !rawString) {
    return rawString
  }

  const parsed = parseFindRegex(script.findRegex)
  if (!parsed) return rawString

  let re
  try {
    re = new RegExp(parsed.source, parsed.flags)
  } catch {
    return rawString
  }

  // {{match}} → $& for expandReplacement. Use function replacer so `$&` is literal.
  const template = String(script.replaceString ?? '').replace(/\{\{match\}\}/gi, () => '$&')

  return rawString.replace(re, (...args) => {
    const m = args[0]
    const last = args[args.length - 1]
    const hasNamed = last != null && typeof last === 'object' && !Array.isArray(last)
    // Signature: match, g1, g2, ..., offset, string [, groups]
    const fixedTail = hasNamed ? 3 : 2 // offset + string [+ groups]
    const groupEnd = args.length - fixedTail
    const groups = args.slice(1, Math.max(groupEnd, 1))
    const namedGroups = hasNamed ? last : undefined
    return expandReplacement(template, m, groups, namedGroups)
  })
}

/**
 * Parent entry: iterate scripts in order with ST stage/placement filters.
 *
 * @param {unknown} raw
 * @param {number} placement
 * @param {{ isMarkdown?: boolean, isPrompt?: boolean, isEdit?: boolean, depth?: number, characterOverride?: string }} [params]
 * @param {RegexScript[]} [scripts]
 * @returns {string}
 */
export function getRegexedString(raw, placement, params = {}, scripts = []) {
  if (typeof raw !== 'string') {
    return ''
  }

  let finalString = raw
  const list = Array.isArray(scripts) ? scripts : []

  for (const script of list) {
    if (
      shouldRunScript(script, {
        isMarkdown: !!params.isMarkdown,
        isPrompt: !!params.isPrompt,
        isEdit: !!params.isEdit,
        depth: params.depth,
        placement,
      })
    ) {
      finalString = runRegexScript(script, finalString)
    }
  }

  return finalString
}

/** @internal test helper — reset substituteRegex warn cache */
export function __resetSubstituteWarnCache() {
  substituteWarnedIds.clear()
}
