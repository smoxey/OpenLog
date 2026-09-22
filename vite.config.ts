/// <reference types="vitest/config" />
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { VitePWA } from 'vite-plugin-pwa';

/**
 * The app version travels into the JSON export envelope, so it has to come from
 * the one place that already tracks it rather than a second hand-edited copy.
 */
const pkg = JSON.parse(
  readFileSync(fileURLToPath(new URL('./package.json', import.meta.url)), 'utf8'),
) as { version: string };

/**
 * Base path for deployment.
 *
 * GitHub Pages hosts project sites at a subpath, e.g.
 *   https://<user>.github.io/<repo>/
 * so the app must be built with `base` set to "/<repo>/".
 *
 * Change this ONE constant (or set the BASE_PATH env var at build time)
 * to match your repository name. For a user/organization root site or
 * local dev, "/" is correct.
 */
const BASE_PATH = process.env.BASE_PATH ?? '/OpenLog/';

export default defineConfig(({ command }) => ({
  // Use root during dev so the placeholder loads at http://localhost:5173/,
  // and the configured subpath for production builds.
  base: command === 'serve' ? '/' : BASE_PATH,
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
  plugins: [
    svelte(),
    VitePWA({
      registerType: 'autoUpdate',
      injectRegister: 'auto',
      manifest: {
        name: 'Open Pilot Logbook',
        short_name: 'Logbook',
        description:
          'Open source, privacy-focused, local-first EASA pilot logbook. All data stays on your device.',
        theme_color: '#0b3d59',
        background_color: '#ffffff',
        display: 'standalone',
        orientation: 'portrait',
        // Placeholder icons — replace with real artwork before release.
        icons: [
          {
            src: 'icons/icon-192.png',
            sizes: '192x192',
            type: 'image/png',
          },
          {
            src: 'icons/icon-512.png',
            sizes: '512x512',
            type: 'image/png',
          },
          {
            src: 'icons/icon-512-maskable.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'maskable',
          },
        ],
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,svg,png,ico,woff2}'],
        // Local-first app shell: precache everything, work fully offline.
        cleanupOutdatedCaches: true,
      },
      devOptions: {
        enabled: false,
      },
    }),
  ],
  /**
   * Component tests need Svelte's CLIENT build.
   *
   * Without the `browser` condition, Vite resolves `svelte` to its server entry
   * under Vitest and every `render()` fails with "mount(...) is not available
   * on the server" — which reads like a Testing Library problem and is not one.
   * Scoped to test runs so the dev server and the production build resolve
   * exactly as they did before.
   */
  resolve: process.env.VITEST ? { conditions: ['browser'] } : {},
  test: {
    globals: true,
    environment: 'jsdom',
    include: ['src/**/*.{test,spec}.ts'],
    setupFiles: ['src/test/setup.ts'],
    /*
     * The component tests drive real keystrokes through `userEvent`, which
     * types one character at a time and yields between each. Filling a whole
     * flight form takes seconds, and with the suite's files running in parallel
     * it can take several — so vitest's 5s default started failing tests that
     * were correct, on a machine that was merely busy.
     *
     * Raised rather than worked around: the assertions all wait properly for
     * the render (see `expectWarning` in `FlightForm.sums.test.ts`), so a test
     * that reaches this limit is genuinely hung, not merely slow.
     */
    testTimeout: 30_000,
  },
}));
