#!/usr/bin/env node
/**
 * Refresh fixtures/golden/display/*.json expected outputs via ST-aligned oracle.
 *
 * Usage (repo root):
 *   node scripts/golden-refresh.mjs
 *   node scripts/golden-refresh.mjs --check   # exit 1 if drift
 *
 * Does NOT load full SillyTavern; uses scripts/lib/stDisplayOracle.mjs
 * (semantic port of ST getRegexedString + Conclave StatusPlaceHolder pre-pass).
 */
import { readdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { processDisplayOracle } from './lib/stDisplayOracle.mjs'
import { normalizeHtml } from '../fixtures/helpers/normalizeHtml.mjs'
import {
  loadCardJson,
  cardRegexScripts,
  cardFirstMes,
  GOLDEN_DISPLAY_ROOT,
} from '../fixtures/helpers/loadCard.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const checkOnly = process.argv.includes('--check')

/** Built-in cases derived from synthetic cards + hand cases. */
function builtInCases() {
  const cases = []

  // From card fixtures
  for (const id of ['minimal-neutral', 'regex-basic', 'status-bar']) {
    const card = loadCardJson(id)
    const scripts = cardRegexScripts(card)
    const raw = cardFirstMes(card)
    cases.push({
      id: `card-${id}-opening`,
      description: `Opening display for fixture card ${id}`,
      source: `fixtures/cards/${id}/card.json`,
      st_align: 'getRegexedString AI_OUTPUT + StatusPlaceHolder pre-pass',
      raw,
      scripts,
      options: { placement: 2, depth: 0 },
    })
  }

  // Explicit ST rule cases
  cases.push({
    id: 'empty-placement-skips',
    description: 'ST: empty placement array skips script',
    source: 'st-engine placement.includes',
    st_align: 'empty placement skip',
    raw: 'hello world',
    scripts: [
      {
        scriptName: 'no-place',
        findRegex: 'hello',
        replaceString: 'bye',
        placement: [],
        markdownOnly: false,
        promptOnly: false,
        disabled: false,
      },
    ],
    options: { placement: 2 },
  })

  cases.push({
    id: 'prompt-only-not-on-display',
    description: 'promptOnly scripts must not change display pipeline output alone',
    source: 'st-engine markdownOnly/promptOnly',
    st_align: 'promptOnly skipped when isPrompt=false',
    raw: '<customized>X</customized>',
    scripts: [
      {
        scriptName: 'prompt only',
        findRegex: '<customized>\\s*(.*?)\\s*</customized>',
        replaceString: 'STRIPPED',
        placement: [2],
        promptOnly: true,
        markdownOnly: false,
        disabled: false,
      },
    ],
    options: { placement: 2 },
  })

  cases.push({
    id: 'depth-min-skips',
    description: 'minDepth filters by depth',
    source: 'st-engine minDepth',
    st_align: 'depth < minDepth skip',
    raw: 'alpha beta',
    scripts: [
      {
        scriptName: 'deep only',
        findRegex: 'alpha',
        replaceString: 'ALPHA',
        placement: [2],
        minDepth: 2,
        maxDepth: null,
        markdownOnly: false,
        promptOnly: false,
        disabled: false,
      },
    ],
    options: { placement: 2, depth: 0 },
  })

  return cases
}

function ensureDir() {
  if (!existsSync(GOLDEN_DISPLAY_ROOT)) {
    throw new Error(`missing golden dir: ${GOLDEN_DISPLAY_ROOT}`)
  }
}

function writeCase(c) {
  const expected = normalizeHtml(processDisplayOracle(c.raw, c.scripts, c.options || {}))
  const out = {
    id: c.id,
    description: c.description,
    source: c.source,
    st_align: c.st_align,
    raw: c.raw,
    scripts: c.scripts,
    options: c.options || {},
    expected,
  }
  const path = join(GOLDEN_DISPLAY_ROOT, `${c.id}.json`)
  if (checkOnly) {
    if (!existsSync(path)) {
      console.error(`MISSING golden: ${path}`)
      process.exitCode = 1
      return
    }
    const prev = JSON.parse(readFileSync(path, 'utf8'))
    if (normalizeHtml(prev.expected) !== expected) {
      console.error(`DRIFT golden: ${c.id}`)
      console.error('  prev:', JSON.stringify(prev.expected).slice(0, 200))
      console.error('  next:', JSON.stringify(expected).slice(0, 200))
      process.exitCode = 1
    } else {
      console.log(`ok  ${c.id}`)
    }
    return
  }
  writeFileSync(path, `${JSON.stringify(out, null, 2)}\n`, 'utf8')
  console.log(`wrote ${path}`)
}

ensureDir()
for (const c of builtInCases()) writeCase(c)

if (checkOnly && !process.exitCode) {
  console.log('All display goldens match ST-aligned oracle.')
}
