#!/usr/bin/env node
/**
 * Refresh / check opening display fingerprints for all tracked real cards.
 *
 *   node scripts/real-card-fingerprints.mjs
 *   node scripts/real-card-fingerprints.mjs --check
 *
 * Uses FE processDisplay (dynamic import) so fingerprints match production path.
 */
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import {
  listTrackedRealCards,
  cardFirstMes,
  cardGreetings,
  cardRegexScripts,
  displayFingerprint,
  FINGERPRINT_DIR,
} from '../fixtures/helpers/realCards.mjs'

const checkOnly = process.argv.includes('--check')
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const pipelineUrl = pathToFileURL(
  join(ROOT, 'frontend/src/st-host/render/RenderPipeline.js'),
).href

const { processDisplay } = await import(pipelineUrl)

mkdirSync(FINGERPRINT_DIR, { recursive: true })

const cards = listTrackedRealCards()
if (cards.length < 3) {
  console.error(`Need >=3 tracked real cards, found ${cards.length}`)
  process.exit(1)
}

let failed = 0
for (const ref of cards) {
  const scripts = cardRegexScripts(ref.card)
  const openings = [cardFirstMes(ref.card), ...cardGreetings(ref.card)]
  const openingFingerprints = openings.map((raw, i) => {
    let html = ''
    let error = null
    try {
      html = processDisplay(raw, scripts)
    } catch (e) {
      error = String(e && e.message ? e.message : e)
    }
    return {
      index: i,
      raw_len: String(raw ?? '').length,
      error,
      fingerprint: error ? null : displayFingerprint(html),
      // short preview for humans (not full HTML)
      preview: error ? null : String(html).replace(/\s+/g, ' ').slice(0, 120),
    }
  })

  const payload = {
    id: ref.id,
    name: ref.name,
    source: ref.path,
    regex_count: scripts.length,
    opening_count: openings.length,
    openings: openingFingerprints,
    st_align:
      'processDisplay = StatusPlaceHolder pre-pass + ST getRegexedString (AI_OUTPUT) + fence strip',
  }

  const outPath = join(FINGERPRINT_DIR, `${ref.id}.json`)
  if (checkOnly) {
    if (!existsSync(outPath)) {
      console.error(`MISSING ${outPath}`)
      failed++
      continue
    }
    const prev = JSON.parse(readFileSync(outPath, 'utf8'))
    const prevHashes = (prev.openings || []).map((o) => o.fingerprint?.sha256)
    const nextHashes = openingFingerprints.map((o) => o.fingerprint?.sha256)
    if (JSON.stringify(prevHashes) !== JSON.stringify(nextHashes)) {
      console.error(`DRIFT ${ref.id}`)
      console.error('  prev', prevHashes)
      console.error('  next', nextHashes)
      failed++
    } else {
      console.log(`ok  ${ref.id} (${openings.length} openings, ${scripts.length} regex)`)
    }
  } else {
    writeFileSync(outPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
    console.log(`wrote ${outPath}`)
  }
}

if (checkOnly && failed) process.exit(1)
if (checkOnly) console.log(`All ${cards.length} real-card opening fingerprints match.`)
