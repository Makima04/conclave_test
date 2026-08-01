#!/usr/bin/env node
/**
 * Dump per-card ST scoped regex inventory for multi-card regression.
 *
 *   node scripts/real-card-regex-inventory.mjs
 *   node scripts/real-card-regex-inventory.mjs --json
 *   node scripts/real-card-regex-inventory.mjs --check
 *
 * Evidence that each tracked card carries its own regex_scripts (not a host fork).
 */
import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  listTrackedRealCards,
  summarizeCardRegex,
  MIN_TRACKED_REAL_CARDS,
} from '../fixtures/helpers/realCards.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const OUT_DIR = join(ROOT, 'fixtures/golden/real-regex-inventory')
const OUT_JSON = join(OUT_DIR, 'inventory.json')
const asJson = process.argv.includes('--json')
const checkOnly = process.argv.includes('--check')

const cards = listTrackedRealCards()
if (cards.length < MIN_TRACKED_REAL_CARDS) {
  console.error(`Need >=${MIN_TRACKED_REAL_CARDS} tracked real cards, found ${cards.length}`)
  process.exit(1)
}

const rows = cards.map((ref) => summarizeCardRegex(ref.card, { id: ref.id, name: ref.name }))

const signatures = rows.map((r) => r.display_signature)
const uniqueSigs = new Set(signatures)
if (uniqueSigs.size < 2) {
  console.error('FAIL: all cards share the same display regex signature — single-card specialization risk')
  process.exit(1)
}

const payload = {
  generated: new Date().toISOString().slice(0, 10),
  st_source: 'data.extensions.regex_scripts (SCOPED) via ST Regex extension engine.js',
  note: 'Each card ships its own display scripts; host must only execute, not hardcode one card.',
  cards: rows,
  unique_display_signatures: uniqueSigs.size,
}

if (checkOnly) {
  if (!existsSync(OUT_JSON)) {
    console.error(`MISSING ${OUT_JSON}; run without --check to write`)
    process.exit(1)
  }
  const prev = JSON.parse(readFileSync(OUT_JSON, 'utf8'))
  const prevMap = Object.fromEntries((prev.cards || []).map((c) => [c.id, c.display_signature]))
  let failed = 0
  for (const row of rows) {
    if (prevMap[row.id] !== row.display_signature) {
      console.error(`DRIFT ${row.id}`)
      console.error('  prev', prevMap[row.id])
      console.error('  next', row.display_signature)
      failed++
    } else {
      console.log(
        `ok  ${row.id}: total=${row.total} display=${row.display_ai_output} (${row.display_script_names.slice(0, 3).join(', ')}${row.display_script_names.length > 3 ? '…' : ''})`,
      )
    }
  }
  if (failed) process.exit(1)
  console.log(`All ${rows.length} card display-regex inventories match.`)
  process.exit(0)
}

if (asJson) {
  console.log(JSON.stringify(payload, null, 2))
} else {
  console.log('# Real-card regex inventory (ST scoped scripts)\n')
  console.log(`Tracked cards: ${rows.length} · unique display signatures: ${uniqueSigs.size}\n`)
  for (const row of rows) {
    console.log(`## ${row.id} — ${row.name}`)
    console.log(
      `- total scripts: **${row.total}** · AI_OUTPUT display-relevant: **${row.display_ai_output}**`,
    )
    console.log(
      `- classes: md=${row.by_class.markdown_only} source=${row.by_class.source} prompt=${row.by_class.prompt_only} mixed=${row.by_class.mixed_md_prompt} disabled=${row.by_class.disabled}`,
    )
    console.log(
      `- trimStrings non-empty: ${row.non_empty_trim_strings} · substituteRegex≠0: ${row.non_zero_substitute_regex}`,
    )
    console.log('- display scripts:')
    for (const name of row.display_script_names) {
      console.log(`  - ${name}`)
    }
    console.log('')
  }
}

mkdirSync(OUT_DIR, { recursive: true })
writeFileSync(OUT_JSON, `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
console.error(`wrote ${OUT_JSON}`)
