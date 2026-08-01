/**
 * Discover and load **real** SillyTavern character cards for multi-card regression.
 *
 * Primary set: fixtures/real-cards/*.json (tracked, multi-author).
 * Optional: backend/data/imported_cards when present (local-only, gitignored).
 *
 * Goal: prevent single-card specialization (e.g. only 苍玄) from silently
 * breaking other cards' display / init / switch behavior.
 */
import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join, basename } from 'node:path'
import { fileURLToPath } from 'node:url'
import { normalizeHtml } from './normalizeHtml.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
export const FIXTURES_ROOT = join(HERE, '..')
export const REAL_CARDS_ROOT = join(FIXTURES_ROOT, 'real-cards')
export const FINGERPRINT_DIR = join(FIXTURES_ROOT, 'golden', 'real-openings')

/**
 * @typedef {Object} RealCardRef
 * @property {string} id
 * @property {string} path
 * @property {string} name
 * @property {object} card
 * @property {'tracked'|'optional'} source
 */

/**
 * @param {string} [root]
 * @returns {RealCardRef[]}
 */
export function listTrackedRealCards(root = REAL_CARDS_ROOT) {
  if (!existsSync(root)) return []
  const manifestPath = join(root, 'manifest.json')
  /** @type {string[]} */
  let files = []
  if (existsSync(manifestPath)) {
    const man = JSON.parse(readFileSync(manifestPath, 'utf8'))
    files = (man.cards || []).map((c) => c.file).filter(Boolean)
  } else {
    files = readdirSync(root).filter((f) => f.endsWith('.json') && f !== 'manifest.json')
  }

  const out = []
  for (const file of files) {
    const path = join(root, file)
    if (!existsSync(path)) {
      throw new Error(`manifest lists missing real card: ${path}`)
    }
    const card = JSON.parse(readFileSync(path, 'utf8'))
    const id = file.replace(/\.json$/i, '')
    out.push({
      id,
      path,
      name: cardName(card),
      card,
      source: 'tracked',
    })
  }
  return out.sort((a, b) => a.id.localeCompare(b.id))
}

/**
 * Optional extra cards from imported_cards (not required for CI).
 * @param {string} [dir]
 * @returns {RealCardRef[]}
 */
export function listOptionalImportedCards(
  dir = join(FIXTURES_ROOT, '../backend/data/imported_cards'),
) {
  if (process.env.CONCLAVE_SKIP_OPTIONAL_CARDS === '1') return []
  if (!existsSync(dir)) return []
  const trackedNames = new Set(
    listTrackedRealCards().map((c) => normalizeName(c.name)),
  )
  const out = []
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.json'))) {
    const path = join(dir, file)
    try {
      const card = JSON.parse(readFileSync(path, 'utf8'))
      const name = cardName(card)
      if (trackedNames.has(normalizeName(name))) continue
      out.push({
        id: `optional-${basename(file, '.json').slice(0, 24)}`,
        path,
        name,
        card,
        source: 'optional',
      })
    } catch {
      /* skip corrupt */
    }
  }
  return out
}

/**
 * All cards for the full local suite: tracked (+ optional if present).
 * CI uses tracked only (imported_cards gitignored).
 * @returns {RealCardRef[]}
 */
export function listAllRealCards() {
  return [...listTrackedRealCards(), ...listOptionalImportedCards()]
}

export function cardName(card) {
  return card?.name || card?.data?.name || 'Unnamed'
}

function normalizeName(n) {
  return String(n || '')
    .trim()
    .toLowerCase()
}

export function cardFirstMes(card) {
  return card?.data?.first_mes ?? card?.first_mes ?? ''
}

export function cardGreetings(card) {
  const g = card?.data?.alternate_greetings
  return Array.isArray(g) ? g : []
}

export function cardRegexScripts(card) {
  const scripts = card?.data?.extensions?.regex_scripts
  return Array.isArray(scripts) ? scripts : []
}

/** ST regex_placement.AI_OUTPUT */
export const AI_OUTPUT_PLACEMENT = 2

/**
 * Classify a scoped regex script for multi-card inventory (ST stages).
 * @param {object} script
 * @returns {'disabled'|'no_placement'|'prompt_only'|'markdown_only'|'source'|'mixed_md_prompt'}
 */
export function classifyRegexScript(script) {
  if (!script) return 'disabled'
  if (script.disabled) return 'disabled'
  const pl = Array.isArray(script.placement) ? script.placement.map(Number) : []
  if (pl.length === 0) return 'no_placement'
  const md = !!script.markdownOnly
  const po = !!script.promptOnly
  if (md && po) return 'mixed_md_prompt'
  if (md) return 'markdown_only'
  if (po) return 'prompt_only'
  return 'source'
}

/**
 * Display-relevant scripts for AI_OUTPUT (what processDisplay may run).
 * Includes markdown_only + source (not prompt_only-only, unless also markdownOnly).
 *
 * @param {object} card
 * @param {{ placement?: number }} [opts]
 * @returns {object[]}
 */
export function cardDisplayRegexScripts(card, opts = {}) {
  const placement = opts.placement ?? AI_OUTPUT_PLACEMENT
  return cardRegexScripts(card).filter((s) => {
    if (!s || s.disabled) return false
    const pl = Array.isArray(s.placement) ? s.placement.map(Number) : []
    if (!pl.includes(Number(placement))) return false
    // prompt-only without markdown never runs on display source/md stages
    if (s.promptOnly && !s.markdownOnly) return false
    return true
  })
}

/**
 * Human/CI inventory of per-card regex (anti single-card specialization evidence).
 *
 * @param {object} card
 * @param {{ id?: string, name?: string }} [meta]
 */
export function summarizeCardRegex(card, meta = {}) {
  const all = cardRegexScripts(card)
  const byClass = {
    disabled: 0,
    no_placement: 0,
    prompt_only: 0,
    markdown_only: 0,
    source: 0,
    mixed_md_prompt: 0,
  }
  const display = cardDisplayRegexScripts(card)
  const displayNames = []
  const allNames = []
  let nonEmptyTrim = 0
  let nonZeroSubstitute = 0

  for (const s of all) {
    const cls = classifyRegexScript(s)
    byClass[cls] = (byClass[cls] || 0) + 1
    allNames.push(String(s.scriptName || s.id || '(unnamed)'))
    const trim = s.trimStrings
    if (Array.isArray(trim) && trim.some((t) => t != null && String(t) !== '')) {
      nonEmptyTrim += 1
    }
    if (s.substituteRegex != null && Number(s.substituteRegex) !== 0) {
      nonZeroSubstitute += 1
    }
  }
  for (const s of display) {
    displayNames.push(String(s.scriptName || s.id || '(unnamed)'))
  }

  return {
    id: meta.id ?? null,
    name: meta.name ?? cardName(card),
    total: all.length,
    display_ai_output: display.length,
    by_class: byClass,
    display_script_names: displayNames,
    all_script_names: allNames,
    non_empty_trim_strings: nonEmptyTrim,
    non_zero_substitute_regex: nonZeroSubstitute,
    /** Stable signature of enabled display script names (order preserved) */
    display_signature: displayNames.join('|'),
  }
}

export function cardTavernHelperScripts(card) {
  const scripts = card?.data?.extensions?.tavern_helper?.scripts
  return Array.isArray(scripts) ? scripts : []
}

export function cardBookEntries(card) {
  const book = card?.data?.character_book
  if (!book) return []
  if (Array.isArray(book)) return book
  if (Array.isArray(book.entries)) return book.entries
  return []
}

/**
 * Build FE InitResponse-like payload from a real card (no backend required).
 */
export function buildInitLikePayload(card, opts = {}) {
  const importId = opts.importId ?? 0
  const sessionEpoch = opts.sessionEpoch ?? 1
  const name = cardName(card)
  const first = cardFirstMes(card)
  const greetings = cardGreetings(card)
  const imported =
    opts.imported ||
    [
      {
        id: importId,
        name,
        entry_count: cardBookEntries(card).length,
        source_file: null,
      },
    ]

  return {
    first_message: first,
    rendered_html: opts.renderedHtmlHint ?? '',
    greetings,
    rendered_greetings: opts.renderedGreetingsHint ?? greetings.map(() => ''),
    worldbook_entries: [],
    tavern_helper_scripts: (cardTavernHelperScripts(card) || []).map((s) => ({
      name: s.name || s.id || 'script',
      type: s.type || s.script_type || '',
      enabled: s.enabled !== false,
    })),
    regex_scripts: cardRegexScripts(card),
    imported_worldbooks: imported,
    current_worldbook_id: importId,
    card_name: name,
    session_epoch: sessionEpoch,
    runtime_requirements: {
      required_shims: [],
      optional_apis: [],
      remote_imports: [],
      warnings: [],
    },
  }
}

/**
 * Stable fingerprint of display HTML for multi-card regression.
 * Full HTML goldens for 1MB cards are unmaintainable; hash + short markers instead.
 *
 * @param {string} html
 * @returns {{ sha256: string, length: number, markers: string[] }}
 */
export function displayFingerprint(html) {
  const norm = normalizeHtml(html)
  const sha256 = createHash('sha256').update(norm, 'utf8').digest('hex')
  const markers = []
  if (/status-card|StatusPlaceHolder/i.test(norm)) markers.push('statusish')
  if (/<!doctype|<div|<section|<article/i.test(norm)) markers.push('htmlish')
  if (/```/.test(norm)) markers.push('fence_remaining')
  if (/灵石/.test(norm)) markers.push('lingshi')
  if (/【GameStart】/.test(norm)) markers.push('raw_gamestart')
  return { sha256, length: norm.length, markers: markers.sort() }
}

/**
 * Distinctive token from a card for pollution checks (must not appear after switch
 * when other card's opening is unrelated).
 * @param {object} card
 * @returns {string}
 */
export function distinctiveToken(card) {
  const name = cardName(card)
  // Prefer long unique name slice; fall back to first_mes slice
  if (name && name.length >= 4) return name.slice(0, Math.min(12, name.length))
  const raw = cardFirstMes(card)
  return String(raw).replace(/\s+/g, ' ').slice(0, 16)
}

/**
 * Minimum real-card count required so multi-card suite is meaningful.
 * Fail hard if someone deletes all but one card (recreates single-card specialization).
 */
export const MIN_TRACKED_REAL_CARDS = 3
