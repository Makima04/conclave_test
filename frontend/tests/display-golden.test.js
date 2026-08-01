/**
 * ST **rule** goldens only (not full character cards).
 * Real cards: see realCards.matrix.test.js + realCards.host.integration.test.js
 */
import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { processDisplay } from '../src/st-host/render/RenderPipeline.js'
import { processDisplayOracle } from '../../scripts/lib/stDisplayOracle.mjs'
import { normalizeHtml } from '../../fixtures/helpers/normalizeHtml.mjs'

const GOLDEN_DIR = join(dirname(fileURLToPath(import.meta.url)), '../../fixtures/golden/display')

function loadGoldens() {
  return readdirSync(GOLDEN_DIR)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((f) => ({ file: f, ...JSON.parse(readFileSync(join(GOLDEN_DIR, f), 'utf8')) }))
}

describe('ST rule goldens (placement / promptOnly / depth)', () => {
  for (const g of loadGoldens()) {
    it(`${g.id}: processDisplay == oracle == expected`, () => {
      const fe = normalizeHtml(processDisplay(g.raw, g.scripts, g.options || {}))
      const oracle = normalizeHtml(processDisplayOracle(g.raw, g.scripts, g.options || {}))
      const expected = normalizeHtml(g.expected)
      expect(oracle).toBe(expected)
      expect(fe).toBe(expected)
    })
  }
})
