/**
 * Display goldens: Conclave processDisplay must match ST-aligned oracle fixtures.
 *
 * Goldens live in fixtures/golden/display/*.json (refreshed via
 * `node scripts/golden-refresh.mjs`).
 */
import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { processDisplay } from '../src/st-host/render/RenderPipeline.js'
import { processDisplayOracle } from '../../scripts/lib/stDisplayOracle.mjs'
import { normalizeHtml, htmlFingerprint } from '../../fixtures/helpers/normalizeHtml.mjs'
import {
  loadCardJson,
  cardRegexScripts,
  cardFirstMes,
  listCardIds,
} from '../../fixtures/helpers/loadCard.mjs'

const GOLDEN_DIR = join(dirname(fileURLToPath(import.meta.url)), '../../fixtures/golden/display')

function loadGoldens() {
  return readdirSync(GOLDEN_DIR)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((f) => {
      const data = JSON.parse(readFileSync(join(GOLDEN_DIR, f), 'utf8'))
      return { file: f, ...data }
    })
}

describe('display golden vs ST-aligned oracle', () => {
  for (const g of loadGoldens()) {
    it(`${g.id}: processDisplay == expected (and oracle)`, () => {
      const fe = normalizeHtml(processDisplay(g.raw, g.scripts, g.options || {}))
      const oracle = normalizeHtml(processDisplayOracle(g.raw, g.scripts, g.options || {}))
      const expected = normalizeHtml(g.expected)

      expect(oracle, 'oracle must match frozen golden').toBe(expected)
      expect(fe, 'FE processDisplay must match golden').toBe(expected)
    })
  }
})

describe('synthetic card openings (observable contracts)', () => {
  it('lists at least the three core fixtures', () => {
    const ids = listCardIds()
    expect(ids).toEqual(expect.arrayContaining(['minimal-neutral', 'regex-basic', 'status-bar']))
  })

  it('minimal-neutral opening has no status-card and no 灵石', () => {
    const card = loadCardJson('minimal-neutral')
    const html = processDisplay(cardFirstMes(card), cardRegexScripts(card))
    expect(html).toContain('neutral demo card')
    expect(html).not.toMatch(/灵石|世界系统|大区域/)
    expect(htmlFingerprint(html).hasStatusCard).toBe(false)
  })

  it('regex-basic opening produces panel div (ST display path)', () => {
    const card = loadCardJson('regex-basic')
    const html = processDisplay(cardFirstMes(card), cardRegexScripts(card))
    expect(html).toContain('class="panel"')
    expect(html).toContain('角色开场')
    expect(html).not.toContain('```')
    // prompt-only must not win on display
    expect(html).not.toBe('开场')
  })

  it('status-bar opening injects status-card when UpdateVariable present', () => {
    const card = loadCardJson('status-bar')
    const html = processDisplay(cardFirstMes(card), cardRegexScripts(card))
    expect(htmlFingerprint(html).hasStatusCard).toBe(true)
    expect(html).toContain('status-card')
    expect(html).not.toContain('<StatusPlaceHolderImpl/>')

    // alternate greeting without variable payload must NOT get status card
    const intro = processDisplay(card.data.alternate_greetings[0], cardRegexScripts(card))
    expect(htmlFingerprint(intro).hasStatusCard).toBe(false)
  })
})
