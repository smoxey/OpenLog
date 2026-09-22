// Provides a spec-compliant, in-memory IndexedDB for the test environment so
// the storage layer (Dexie) can be exercised without a real browser.
import 'fake-indexeddb/auto';

// Component testing, added in Prompt 3b-2. This settles the open question the
// project carried since 3b-1, whose only bug — a Svelte `$state` proxy reaching
// IndexedDB — was invisible to 246 passing unit tests and turned up on the
// first real click.
//
// IT DOES NOT REPLACE A REAL BROWSER, and must not be trusted to. jsdom has no
// structured-clone implementation behind IndexedDB, so that exact class of bug
// is STILL invisible here. Component tests cover wiring, wording and state
// transitions; a real click-through is what covers the rest, and the import
// flow gets both.
import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/svelte';
import { afterEach } from 'vitest';

afterEach(() => {
  cleanup();
});

/**
 * `Blob.prototype.text()` — a jsdom gap, not an app one.
 *
 * jsdom 25 ships `Blob` and `File` without `.text()`, so any component that
 * reads a picked file dies with "f.text is not a function" — which looks like
 * an application bug and is not one. The method is standard and has been in
 * every browser this app targets since 2019 (Chrome 76, Firefox 69, Safari 14),
 * including iOS Safari, so the production code is right to use it.
 *
 * Defined only when missing, so a future jsdom that implements it properly
 * takes precedence over this stand-in.
 */
if (typeof Blob !== 'undefined' && typeof Blob.prototype.text !== 'function') {
  Blob.prototype.text = function text(this: Blob): Promise<string> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => reject(reader.error);
      reader.readAsText(this);
    });
  };
}

/**
 * `window.matchMedia` — a jsdom gap, not an app one.
 *
 * jsdom implements the CSSOM but not the media-query matcher, so any component
 * that asks whether the viewport is wide dies on `matchMedia is not a
 * function`. The API is standard and universally supported in the browsers this
 * app targets, so the production code is right to use it.
 *
 * This is a real implementation, not a constant: it parses `(min-width: Npx)`
 * and `(max-width: Npx)` against `window.innerWidth`, so a test that resizes
 * the window gets the answer it should. Anything else it cannot parse reports
 * no match, which is the safe direction — a component falls back to its narrow
 * layout rather than rendering a desktop table nobody asked for.
 *
 * The change listener is a no-op: jsdom never resizes on its own, so there is
 * nothing to fire.
 */
if (typeof window !== 'undefined' && typeof window.matchMedia !== 'function') {
  window.matchMedia = (query: string): MediaQueryList => {
    const min = /\(\s*min-width:\s*(\d+)px\s*\)/.exec(query);
    const max = /\(\s*max-width:\s*(\d+)px\s*\)/.exec(query);
    let matches = false;
    if (min) matches = window.innerWidth >= Number(min[1]);
    else if (max) matches = window.innerWidth <= Number(max[1]);

    return {
      matches,
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      // Deprecated, but some libraries still reach for them.
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    } as MediaQueryList;
  };
}

/**
 * `IntersectionObserver` — another jsdom gap.
 *
 * Used by the list's scroll sentinel to page in more rows. Nothing in jsdom
 * ever scrolls or lays anything out, so a stub that observes nothing is
 * honest: a component test sees the first page of rows, which is what a real
 * browser shows before the user scrolls.
 *
 * IT DOES MEAN PAGINATION ITSELF IS NOT COVERED HERE. A test that needs more
 * than one page of results is a test that needs a real browser.
 */
if (typeof globalThis.IntersectionObserver === 'undefined') {
  class StubIntersectionObserver implements IntersectionObserver {
    readonly root = null;
    readonly rootMargin = '';
    readonly thresholds: readonly number[] = [];
    observe() {}
    unobserve() {}
    disconnect() {}
    takeRecords(): IntersectionObserverEntry[] {
      return [];
    }
  }
  globalThis.IntersectionObserver =
    StubIntersectionObserver as unknown as typeof IntersectionObserver;
}
