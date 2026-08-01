import { defineConfig } from 'vitest/config'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(fileURLToPath(import.meta.url))

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.js', 'tests/**/*.test.js'],
    // Allow importing fixtures/ and scripts/ from monorepo root
    server: {
      deps: {
        inline: [],
      },
    },
  },
  resolve: {
    alias: {
      '@fixtures': join(root, '../fixtures'),
    },
  },
})
