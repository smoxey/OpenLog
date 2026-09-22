/// <reference types="vitest/config" />
import { defineConfig } from 'vitest/config';

/**
 * Config for the fixture-regeneration script ONLY.
 *
 * The main config's test glob is `src/**` so an ordinary `npm test` can never
 * run something that WRITES to the fixtures it is meant to be checking. This
 * config points exclusively at `scripts/`, and is used by
 * `npm run fixtures:regenerate`.
 *
 * A separate config rather than a CLI flag because vitest has no `--include`,
 * and rather than an env-var guard because that would need `cross-env` to work
 * on Windows — and this project does not add dependencies for conveniences.
 */
export default defineConfig({
  test: {
    include: ['scripts/*.spec.ts'],
    environment: 'node',
  },
});
