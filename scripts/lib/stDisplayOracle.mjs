/**
 * SillyTavern-aligned display oracle.
 *
 * Single source of truth: frontend RenderPipeline / RegexEngine.
 * Avoids dual-implementation drift between scripts/ and FE (historical bug source).
 *
 * Full ST runtime (extension_settings, character macros, Regex presets) is NOT loaded.
 *
 * @module scripts/lib/stDisplayOracle
 */

import { pathToFileURL } from 'node:url'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..')
const regexUrl = pathToFileURL(join(ROOT, 'frontend/src/st-host/render/RegexEngine.js')).href
const pipelineUrl = pathToFileURL(join(ROOT, 'frontend/src/st-host/render/RenderPipeline.js')).href

const regexMod = await import(regexUrl)
const pipelineMod = await import(pipelineUrl)

export const regex_placement = regexMod.regex_placement
export const substitute_find_regex = regexMod.substitute_find_regex
export const parseFindRegex = regexMod.parseFindRegex
export const expandReplacement = regexMod.expandReplacement
export const filterTrimStrings = regexMod.filterTrimStrings
export const runRegexScript = regexMod.runRegexScript
export const getRegexedString = regexMod.getRegexedString
export const shouldRunScript = regexMod.shouldRunScript

/**
 * Full Conclave/ST-aligned display pipeline (oracle for goldens).
 * Identical to FE `processDisplay`.
 *
 * @param {string} raw
 * @param {object[]} scripts
 * @param {{ placement?: number, depth?: number, isEdit?: boolean, hasTavernHelperScripts?: boolean }} [options]
 */
export function processDisplayOracle(raw, scripts, options = {}) {
  return pipelineMod.processDisplay(raw, scripts, options)
}
