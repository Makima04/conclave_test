#!/usr/bin/env node
/**
 * Smoke-check: intentional illegal cross-layer imports must fail ESLint.
 *
 * Architecture (docs/architecture-host-mind.md §1):
 *   st-host ↛ mind
 *   mind ↛ st-host / shell
 *   bridge ↛ st-host / mind / shell
 *   shared ↛ shell / session / st-host / mind
 *
 * Usage (from frontend/):
 *   node scripts/check-import-boundaries.mjs
 *   npm run check:import-boundaries
 *
 * Exit 0 = boundaries enforced (violations rejected as expected).
 * Exit 1 = config failed to catch a violation (or eslint itself errored unexpectedly).
 */
import { spawnSync } from 'node:child_process'
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const root = join(__dirname, '..')
const tmpDir = join(root, '.boundary-check-tmp')

/** Each case: file under a restricted zone that illegally imports a forbidden layer. */
const cases = [
  {
    name: 'st-host ↛ mind',
    relPath: 'src/st-host/__boundary_probe__.js',
    source: `import { probe } from '../mind/__boundary_target__.js'\nexport const x = probe\n`,
  },
  {
    name: 'mind ↛ st-host',
    relPath: 'src/mind/__boundary_probe__.js',
    source: `import { probe } from '../st-host/__boundary_target__.js'\nexport const x = probe\n`,
  },
  {
    name: 'mind ↛ shell',
    relPath: 'src/mind/__boundary_probe_shell__.js',
    source: `import { probe } from '../shell/__boundary_target__.js'\nexport const x = probe\n`,
  },
  {
    name: 'bridge ↛ st-host',
    relPath: 'src/bridge/__boundary_probe__.js',
    source: `import { probe } from '../st-host/__boundary_target__.js'\nexport const x = probe\n`,
  },
  {
    name: 'shared ↛ session',
    relPath: 'src/shared/__boundary_probe__.js',
    source: `import { probe } from '../session/__boundary_target__.js'\nexport const x = probe\n`,
  },
]

const targetStub = `export const probe = true\n`

function writeProbeTree() {
  mkdirSync(tmpDir, { recursive: true })
  // Stub modules so import paths are syntactically valid layer names.
  for (const layer of ['mind', 'st-host', 'shell', 'session', 'bridge', 'shared']) {
    const dir = join(root, 'src', layer)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, '__boundary_target__.js'), targetStub)
  }
  for (const c of cases) {
    const abs = join(root, c.relPath)
    mkdirSync(dirname(abs), { recursive: true })
    writeFileSync(abs, c.source)
  }
}

function cleanup() {
  for (const c of cases) {
    const abs = join(root, c.relPath)
    if (existsSync(abs)) rmSync(abs)
  }
  for (const layer of ['mind', 'st-host', 'shell', 'session', 'bridge', 'shared']) {
    const stub = join(root, 'src', layer, '__boundary_target__.js')
    if (existsSync(stub)) rmSync(stub)
  }
  if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true })
}

function runEslint(fileRel) {
  const result = spawnSync(
    'npx',
    ['eslint', fileRel, '--no-warn-ignored'],
    {
      cwd: root,
      encoding: 'utf8',
      env: process.env,
    },
  )
  return {
    status: result.status,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
  }
}

function main() {
  let failed = false
  const results = []

  try {
    writeProbeTree()

    for (const c of cases) {
      const { status, stdout, stderr } = runEslint(c.relPath)
      const combined = `${stdout}\n${stderr}`
      const rejected =
        status !== 0 &&
        (combined.includes('no-restricted-imports') ||
          combined.includes('Architecture boundary'))

      results.push({ name: c.name, status, rejected, combined })

      if (!rejected) {
        failed = true
        console.error(`FAIL: expected lint rejection for "${c.name}"`)
        console.error(`  file: ${c.relPath}`)
        console.error(`  eslint exit: ${status}`)
        console.error(combined.trim() || '(no output)')
      } else {
        console.log(`OK: "${c.name}" rejected by eslint (exit ${status})`)
      }
    }
  } finally {
    cleanup()
  }

  // Legitimate codebase must still lint clean.
  const baseline = spawnSync('npx', ['eslint', '.'], {
    cwd: root,
    encoding: 'utf8',
    env: process.env,
  })
  if (baseline.status !== 0) {
    failed = true
    console.error('FAIL: baseline `npm run lint` is not clean after probe cleanup')
    console.error(baseline.stdout)
    console.error(baseline.stderr)
  } else {
    console.log('OK: baseline eslint . is clean')
  }

  if (failed) {
    console.error('\nImport boundary check FAILED')
    process.exit(1)
  }

  console.log('\nImport boundary check passed (illegal cross-layer imports are rejected).')
  process.exit(0)
}

main()
