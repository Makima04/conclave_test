/**
 * Load synthetic card fixtures from fixtures/cards/<id>/card.json.
 * Works from both frontend (vitest) and Node scripts.
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
export const FIXTURES_ROOT = join(HERE, '..')
export const CARDS_ROOT = join(FIXTURES_ROOT, 'cards')
export const GOLDEN_DISPLAY_ROOT = join(FIXTURES_ROOT, 'golden', 'display')

/**
 * @param {string} cardId directory name under fixtures/cards
 * @returns {object}
 */
export function loadCardJson(cardId) {
  const path = join(CARDS_ROOT, cardId, 'card.json')
  if (!existsSync(path)) {
    throw new Error(`card fixture missing: ${path}`)
  }
  return JSON.parse(readFileSync(path, 'utf8'))
}

/**
 * @returns {string[]}
 */
export function listCardIds() {
  if (!existsSync(CARDS_ROOT)) return []
  return readdirSync(CARDS_ROOT, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .filter((id) => existsSync(join(CARDS_ROOT, id, 'card.json')))
    .sort()
}

/**
 * @param {object} card
 * @returns {object[]}
 */
export function cardRegexScripts(card) {
  const scripts = card?.data?.extensions?.regex_scripts
  return Array.isArray(scripts) ? scripts : []
}

/**
 * @param {object} card
 * @returns {string}
 */
export function cardFirstMes(card) {
  return card?.data?.first_mes || card?.first_mes || ''
}

/**
 * @param {object} card
 * @returns {string[]}
 */
export function cardGreetings(card) {
  const g = card?.data?.alternate_greetings
  return Array.isArray(g) ? g : []
}

/**
 * Build a FE-shaped InitResponse-like payload without running the backend.
 * Display authority remains processDisplay on the FE; rendered_* are hints only.
 *
 * @param {object} card
 * @param {{
 *   sessionEpoch?: number,
 *   importId?: number,
 *   imported?: Array<{ id: number, name: string }>,
 *   renderedHtmlHint?: string,
 *   renderedGreetingsHint?: string[],
 * }} [opts]
 */
export function buildInitLikePayload(card, opts = {}) {
  const importId = opts.importId ?? 0
  const sessionEpoch = opts.sessionEpoch ?? 1
  const name = card?.name || card?.data?.name || 'Unnamed'
  const first = cardFirstMes(card)
  const greetings = cardGreetings(card)
  const imported =
    opts.imported ||
    [
      {
        id: importId,
        name,
        entry_count: card?.data?.character_book?.entries?.length || 0,
        source_file: null,
      },
    ]

  return {
    first_message: first,
    rendered_html: opts.renderedHtmlHint ?? '',
    greetings,
    rendered_greetings: opts.renderedGreetingsHint ?? greetings.map(() => ''),
    worldbook_entries: [],
    tavern_helper_scripts: [],
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
