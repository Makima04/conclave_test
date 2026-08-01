#!/usr/bin/env node
/**
 * Refresh ST **rule** goldens only (empty placement / promptOnly / depth).
 * Real-card openings use scripts/real-card-fingerprints.mjs instead.
 *
 *   node scripts/golden-refresh.mjs
 *   node scripts/golden-refresh.mjs --check
 */
import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { processDisplayOracle } from './lib/stDisplayOracle.mjs'
import { normalizeHtml } from '../fixtures/helpers/normalizeHtml.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const GOLDEN_DIR = join(ROOT, 'fixtures/golden/display')
const checkOnly = process.argv.includes('--check')
mkdirSync(GOLDEN_DIR, { recursive: true })

function cases() {
  return [
    {
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
    },
    {
      id: 'prompt-only-not-on-display',
      description: 'promptOnly must not change display alone',
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
    },
    {
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
    },
  ]
}

let failed = 0
for (const c of cases()) {
  const expected = normalizeHtml(processDisplayOracle(c.raw, c.scripts, c.options || {}))
  const out = { ...c, expected }
  const path = join(GOLDEN_DIR, `${c.id}.json`)
  if (checkOnly) {
    if (!existsSync(path)) {
      console.error(`MISSING ${path}`)
      failed++
      continue
    }
    const prev = JSON.parse(readFileSync(path, 'utf8'))
    if (normalizeHtml(prev.expected) !== expected) {
      console.error(`DRIFT ${c.id}`)
      failed++
    } else console.log(`ok  ${c.id}`)
  } else {
    writeFileSync(path, `${JSON.stringify(out, null, 2)}\n`, 'utf8')
    console.log(`wrote ${path}`)
  }
}
if (checkOnly && failed) process.exit(1)
if (checkOnly) console.log('Rule goldens OK.')
