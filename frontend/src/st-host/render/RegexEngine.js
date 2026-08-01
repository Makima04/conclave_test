/**
 * Display-side regex engine aligned with SillyTavern getRegexedString /
 * runRegexScript (public/scripts/extensions/regex/engine.js) and Rust
 * expand_replacement ($n golden, $fabaoGrid safety).
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
 * ST substitute_find_regex
 * @readonly
 */
export const substitute_find_regex = {
  NONE: 0,
  RAW: 1,
  ESCAPED: 2,
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
 * @property {number} [substituteRegex]
 * @property {string[]} [trimStrings]  ST: strip from each capture before insert
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
    void new RegExp(source, flags)
    return { source, flags }
  } catch {
    return null
  }
}

/**
 * Escape a string for safe use inside a RegExp source (ST sanitizeRegexMacro-ish).
 * @param {string} value
 * @returns {string}
 */
export function escapeRegExp(value) {
  return String(value ?? '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Minimal ST substituteParams for trimStrings / findRegex macros.
 * Supports {{char}}/{{charName}}/{{name}} (characterOverride) and {{user}}.
 *
 * @param {string} text
 * @param {{ characterOverride?: string, userName?: string, macros?: Record<string, string> }} [ctx]
 * @returns {string}
 */
export function substituteBasicParams(text, ctx = {}) {
  let out = text == null ? '' : String(text)
  const charName = ctx.characterOverride != null ? String(ctx.characterOverride) : ''
  const userName = ctx.userName != null ? String(ctx.userName) : 'User'
  const macros = ctx.macros && typeof ctx.macros === 'object' ? ctx.macros : {}

  out = out.replace(/\{\{char(?:Name)?\}\}/gi, () => charName)
  out = out.replace(/\{\{name\}\}/gi, () => charName)
  out = out.replace(/\{\{user\}\}/gi, () => userName)
  for (const [key, val] of Object.entries(macros)) {
    if (!key) continue
    const re = new RegExp(`\\{\\{${escapeRegExp(key)}\\}\\}`, 'gi')
    out = out.replace(re, () => String(val ?? ''))
  }
  return out
}

/**
 * ST filterString: remove each trimString (after macro sub) from a capture value.
 *
 * @param {string} rawString
 * @param {string[]|undefined|null} trimStrings
 * @param {{ characterOverride?: string, userName?: string, macros?: Record<string, string> }} [ctx]
 * @returns {string}
 */
export function filterTrimStrings(rawString, trimStrings, ctx = {}) {
  let finalString = rawString == null ? '' : String(rawString)
  const list = Array.isArray(trimStrings) ? trimStrings : []
  for (const trimString of list) {
    if (trimString == null || trimString === '') continue
    const sub = substituteBasicParams(String(trimString), ctx)
    if (!sub) continue
    finalString = finalString.split(sub).join('')
  }
  return finalString
}

/**
 * Rust-compatible `$` expansion plus ST extras:
 * - `$$` → `$`
 * - `$&` / `$0` → full match
 * - `$1`–`$99` (two-digit only when that group exists)
 * - `${name}` and ST `$<name>` named groups
 * - Bare `$fabao…` stays `$` + rest (JS safety)
 * - Optional trimStrings applied only to expanded captures (ST filterString)
 *
 * @param {string} template
 * @param {string} match  full match ($& / $0)
 * @param {Array<string|undefined>} groups  $1.. at indices 0..
 * @param {Record<string, string>|undefined|null} namedGroups
 * @param {{ trimStrings?: string[], characterOverride?: string, userName?: string, macros?: Record<string, string> }} [options]
 * @returns {string}
 */
export function expandReplacement(
  template,
  match,
  groups = [],
  namedGroups = undefined,
  options = {},
) {
  const tpl = template == null ? '' : String(template)
  const full = match == null ? '' : String(match)
  const captureCount = Array.isArray(groups) ? groups.length : 0
  const trimCtx = {
    characterOverride: options.characterOverride,
    userName: options.userName,
    macros: options.macros,
  }
  const trimList = options.trimStrings
  const filterCap = (value) => filterTrimStrings(value, trimList, trimCtx)

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
      output += filterCap(full)
      i += 2
      continue
    }

    // ST: $<name>
    if (next === '<') {
      i += 2
      let name = ''
      let closed = false
      while (i < tpl.length) {
        const c = tpl[i]
        i += 1
        if (c === '>') {
          closed = true
          break
        }
        name += c
      }
      if (closed) {
        if (namedGroups && Object.prototype.hasOwnProperty.call(namedGroups, name)) {
          const v = namedGroups[name]
          output += filterCap(v == null ? '' : String(v))
        } else {
          // ST returns '' for missing named group when matched by $<…>; keep token only if unclosed
          output += ''
        }
      } else {
        output += '$<'
        output += name
      }
      continue
    }

    // $0 full match (ST {{match}} → $0); $1–$9 with optional two-digit
    if (next >= '0' && next <= '9') {
      if (next === '0') {
        // $0 → full match; $0X with second digit: ST Number('0X') for multi-digit
        const second = tpl[i + 2]
        if (second !== undefined && second >= '0' && second <= '9') {
          // multi-digit starting with 0: use Number like ST ($01 → group 1)
          let j = i + 1
          let numStr = ''
          while (j < tpl.length && tpl[j] >= '0' && tpl[j] <= '9') {
            numStr += tpl[j]
            j += 1
          }
          const idx = Number(numStr)
          if (idx === 0) {
            output += filterCap(full)
            i = j
            continue
          }
          if (idx <= captureCount) {
            const g = groups[idx - 1]
            output += filterCap(g == null ? '' : String(g))
            i = j
            continue
          }
          // unknown group → empty (ST)
          i = j
          continue
        }
        output += filterCap(full)
        i += 2
        continue
      }

      const firstDigit = next
      const firstIndex = Number(firstDigit)
      const second = tpl[i + 2]
      if (second !== undefined && second >= '0' && second <= '9') {
        const twoDigitIndex = firstIndex * 10 + Number(second)
        if (twoDigitIndex <= captureCount) {
          const g = groups[twoDigitIndex - 1]
          output += filterCap(g == null ? '' : String(g))
          i += 3
          continue
        }
      }
      if (firstIndex <= captureCount) {
        const g = groups[firstIndex - 1]
        output += filterCap(g == null ? '' : String(g))
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
          output += filterCap(v == null ? '' : String(v))
        } else {
          // Keep ${name} for JS template literals in replace strings ($ {fb.id})
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
 * Resolve findRegex with ST substituteRegex modes.
 * RAW/ESCAPED only apply when macros/characterOverride are provided; otherwise
 * identity + one-time warn (current tracked real cards all use substituteRegex=0).
 *
 * @param {RegexScript} script
 * @param {{ characterOverride?: string, userName?: string, macros?: Record<string, string> }} [ctx]
 * @returns {string|null}
 */
export function resolveFindRegexString(script, ctx = {}) {
  if (!script?.findRegex) return null
  const mode = Number(script.substituteRegex ?? 0)
  const raw = String(script.findRegex)

  if (mode === substitute_find_regex.NONE || Number.isNaN(mode)) {
    return raw
  }

  const hasMacros =
    (ctx.characterOverride != null && String(ctx.characterOverride) !== '') ||
    (ctx.userName != null && String(ctx.userName) !== '') ||
    (ctx.macros && Object.keys(ctx.macros).length > 0)

  if (!hasMacros) {
    const warnKey = String(script.id || script.scriptName || script.findRegex || '?')
    if (!substituteWarnedIds.has(warnKey)) {
      substituteWarnedIds.add(warnKey)
      console.warn(
        `[ConclaveSTHost] substituteRegex=${mode} needs macros/characterOverride; using raw findRegex (script: ${warnKey})`,
      )
    }
    return raw
  }

  if (mode === substitute_find_regex.RAW) {
    return substituteBasicParams(raw, ctx)
  }
  if (mode === substitute_find_regex.ESCAPED) {
    // ST substitutes macros with regex-sanitized values; we escape the whole substituted string's macro slots via per-macro escape
    let out = raw
    const charName = ctx.characterOverride != null ? String(ctx.characterOverride) : ''
    const userName = ctx.userName != null ? String(ctx.userName) : 'User'
    out = out.replace(/\{\{char(?:Name)?\}\}/gi, () => escapeRegExp(charName))
    out = out.replace(/\{\{name\}\}/gi, () => escapeRegExp(charName))
    out = out.replace(/\{\{user\}\}/gi, () => escapeRegExp(userName))
    const macros = ctx.macros && typeof ctx.macros === 'object' ? ctx.macros : {}
    for (const [key, val] of Object.entries(macros)) {
      if (!key) continue
      const re = new RegExp(`\\{\\{${escapeRegExp(key)}\\}\\}`, 'gi')
      out = out.replace(re, () => escapeRegExp(String(val ?? '')))
    }
    return out
  }

  console.warn(
    `[ConclaveSTHost] Unknown substituteRegex value ${mode}; using raw findRegex`,
  )
  return raw
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

  // Empty placement array → skip (ST); coerce numbers (card JSON may use strings)
  const pl = script.placement
  if (!Array.isArray(pl) || pl.length === 0) return false
  const placementNum = Number(placement)
  if (!pl.map(Number).includes(placementNum)) return false

  return true
}

/**
 * Run a single regex script. Maps `{{match}}` → full match (ST `$0`).
 * Applies trimStrings to expanded captures (ST filterString).
 *
 * @param {RegexScript} script
 * @param {string} rawString
 * @param {{ characterOverride?: string, userName?: string, macros?: Record<string, string> }} [ctx]
 * @returns {string}
 */
export function runRegexScript(script, rawString, ctx = {}) {
  if (!script || script.disabled || !script.findRegex || !rawString) {
    return rawString
  }

  const findStr = resolveFindRegexString(script, ctx)
  if (findStr == null) return rawString

  const parsed = parseFindRegex(findStr)
  if (!parsed) return rawString

  let re
  try {
    re = new RegExp(parsed.source, parsed.flags)
  } catch {
    return rawString
  }

  // ST: {{match}} → $0 (full match via expandReplacement)
  const template = String(script.replaceString ?? '').replace(/\{\{match\}\}/gi, () => '$0')
  const expandOpts = {
    trimStrings: script.trimStrings,
    characterOverride: ctx.characterOverride,
    userName: ctx.userName,
    macros: ctx.macros,
  }

  return rawString.replace(re, (...args) => {
    const m = args[0]
    const last = args[args.length - 1]
    const hasNamed = last != null && typeof last === 'object' && !Array.isArray(last)
    // Signature: match, g1, g2, ..., offset, string [, groups]
    const fixedTail = hasNamed ? 3 : 2
    const groupEnd = args.length - fixedTail
    const groups = args.slice(1, Math.max(groupEnd, 1))
    const namedGroups = hasNamed ? last : undefined
    return expandReplacement(template, m, groups, namedGroups, expandOpts)
  })
}

/**
 * Parent entry: iterate scripts in order with ST stage/placement filters.
 *
 * @param {unknown} raw
 * @param {number} placement
 * @param {{ isMarkdown?: boolean, isPrompt?: boolean, isEdit?: boolean, depth?: number, characterOverride?: string, userName?: string, macros?: Record<string, string> }} [params]
 * @param {RegexScript[]} [scripts]
 * @returns {string}
 */
export function getRegexedString(raw, placement, params = {}, scripts = []) {
  if (typeof raw !== 'string') {
    return ''
  }

  let finalString = raw
  const list = Array.isArray(scripts) ? scripts : []
  const runCtx = {
    characterOverride: params.characterOverride,
    userName: params.userName,
    macros: params.macros,
  }

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
      finalString = runRegexScript(script, finalString, runCtx)
    }
  }

  return finalString
}

/** @internal test helper — reset substituteRegex warn cache */
export function __resetSubstituteWarnCache() {
  substituteWarnedIds.clear()
}
