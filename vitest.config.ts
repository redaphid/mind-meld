import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    coverage: {
      provider: 'v8',
      // Coverage is measured over ALL of src, tested or not. Narrowing this
      // include (or excluding untested files) inflates the percentage without
      // improving anything — that is cheating the ratchet and any change here
      // needs an explicit justification in the PR. See docs/quality-ratchet.md.
      all: true,
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.test.ts', 'src/**/*.d.ts', 'src/__tests__/**'],
      reporter: ['text-summary', 'json-summary'],
      reportsDirectory: 'coverage',
    },
  },
});
