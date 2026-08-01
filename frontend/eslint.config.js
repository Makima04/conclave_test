import js from '@eslint/js'
import globals from 'globals'
import { defineConfig, globalIgnores } from 'eslint/config'

/**
 * Host / Mind layer import boundaries (docs/architecture-host-mind.md §1).
 *
 * eslint-plugin-import peer only goes to ESLint 9; we use built-in
 * no-restricted-imports with regex patterns (ESLint 10-compatible).
 * Patterns match the import source string (relative or absolute).
 */
function forbidLayers(layers, message) {
  const alt = layers.map((l) => l.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')
  return {
    'no-restricted-imports': [
      'error',
      {
        patterns: [
          {
            regex: `(^|/)(${alt})(/|$)`,
            message,
          },
        ],
      },
    ],
  }
}

const boundaryRules = [
  {
    files: ['src/st-host/**/*.{js,mjs,cjs,ts,tsx}'],
    rules: forbidLayers(
      ['mind'],
      'Architecture boundary: st-host must not import mind (docs/architecture-host-mind.md §1). Integrate via bridge ports only.',
    ),
  },
  {
    files: ['src/mind/**/*.{js,mjs,cjs,ts,tsx}'],
    rules: forbidLayers(
      ['st-host', 'shell'],
      'Architecture boundary: mind must not import st-host or shell (docs/architecture-host-mind.md §1). Use bridge ports only.',
    ),
  },
  {
    files: ['src/bridge/**/*.{js,mjs,cjs,ts,tsx}'],
    rules: forbidLayers(
      ['st-host', 'mind', 'shell'],
      'Architecture boundary: bridge must not import st-host, mind, or shell implementations (docs/architecture-host-mind.md §1).',
    ),
  },
  {
    files: ['src/shared/**/*.{js,mjs,cjs,ts,tsx}'],
    rules: forbidLayers(
      ['shell', 'session', 'st-host', 'mind'],
      'Architecture boundary: shared must not import shell, session, st-host, or mind (docs/architecture-host-mind.md §1). Keep shared pure.',
    ),
  },
]

export default defineConfig([
  globalIgnores(['dist']),
  {
    files: ['**/*.{js,mjs,cjs}'],
    extends: [js.configs.recommended],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: {
        ...globals.browser,
        ...globals.node,
      },
    },
  },
  ...boundaryRules,
])
