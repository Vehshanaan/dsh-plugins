import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['tests/**/*.spec.ts'],
    environment: 'node',
  },
  server: {
    fs: {
      // The mock adapter lives in the parent repo's test tree.
      allow: ['../..'],
    },
  },
})