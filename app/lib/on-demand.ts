"use client";

import { useEffect, useSyncExternalStore } from 'react';

/**
 * Code that is downloaded when a visitor first needs it, not with the page.
 *
 * react-day-picker, date-fns and DOMPurify used to ship in the homepage's own
 * bundle, and none of them does anything until a visitor opens a property or
 * the "When" filter. They are fetched on demand through this module instead,
 * so the homepage's critical path no longer carries them.
 *
 * ── Why not `next/dynamic` ──
 * `next/dynamic` is `React.lazy` underneath, and a lazy component suspends on
 * its first client render even when its chunk is already in the browser
 * cache: the loader hands back a promise, and a promise never settles
 * synchronously. React 19 then commits the Suspense fallback and throttles
 * the reveal, so the content appears no sooner than 300 ms after the fallback
 * did. A calendar that was ready 5 ms later would be held back by the loading
 * mechanism itself.
 *
 * So a module is kept here once it has arrived, and components read it
 * synchronously: nothing while it is on its way, the module afterwards. A
 * component that mounts after the download has finished renders the real
 * thing on its first render, with no fallback in between.
 *
 * ── Hydration ──
 * The server never loads these modules, so the server snapshot is always
 * "pending", and React uses the server snapshot for the hydration render. A
 * module that is already loaded is picked up on the render after hydration,
 * never during it, so the server HTML is always matched.
 *
 * ── Re-renders ──
 * Subscribers re-render only when a module arrives or fails — not when its
 * download starts, which changes nothing on screen. Subscribe from the
 * smallest component that shows the module (an icon, the calendar's slot),
 * not from a whole panel: the arrival then re-renders that leaf alone. Where
 * a component only needs the download started, call `preload()` instead.
 *
 * ── Failure ──
 * A failed download stays failed for the life of the page. Turbopack's
 * runtime caches every chunk load by URL, the failed ones included, so a
 * second `import()` of the same chunk rejects at once without making a
 * request — retrying in place cannot work. The "failed" state is there so a
 * surface can say so and offer a reload, instead of waiting forever.
 */

/** "pending" covers both not yet asked for and on its way: they look the same. */
export type OnDemandState<T> =
  | { status: 'pending' | 'failed'; value: null }
  | { status: 'loaded'; value: T };

export interface OnDemand<T> {
  /** Start the download unless it is under way or done. Resolves with the module. */
  load(): Promise<T>;
  /** `load()` for callers that only want the download started, e.g. on hover. */
  preload(): void;
  getState(): OnDemandState<T>;
  subscribe(onChange: () => void): () => void;
}

const PENDING = { status: 'pending', value: null } as const;

export function onDemand<T>(importer: () => Promise<T>): OnDemand<T> {
  let state: OnDemandState<T> = PENDING;
  let pending: Promise<T> | null = null;
  const listeners = new Set<() => void>();

  const set = (next: OnDemandState<T>) => {
    state = next;
    listeners.forEach((listener) => listener());
  };

  const load = (): Promise<T> => {
    if (state.status === 'loaded') return Promise.resolve(state.value);
    if (!pending) {
      pending = importer().then(
        (value) => {
          set({ status: 'loaded', value });
          return value;
        },
        (error: unknown) => {
          console.error('[on-demand] A chunk failed to load:', error);
          set({ status: 'failed', value: null });
          throw error;
        },
      );
    }
    return pending;
  };

  return {
    load,
    preload: () => {
      // The failure is already logged and published as state; nothing to add.
      load().catch(() => {});
    },
    getState: () => state,
    subscribe: (onChange) => {
      listeners.add(onChange);
      return () => {
        listeners.delete(onChange);
      };
    },
  };
}

/** Nothing is ever loaded on the server. */
const serverState = (): OnDemandState<never> => PENDING;

/**
 * Where `code` stands, re-rendering when that changes. Starts the download
 * once `wanted` is true.
 */
export function useOnDemand<T>(code: OnDemand<T>, wanted: boolean): OnDemandState<T> {
  const state = useSyncExternalStore(code.subscribe, code.getState, serverState);

  useEffect(() => {
    if (wanted) code.preload();
  }, [code, wanted]);

  return state;
}

// ─── What is loaded on demand ─────────────────────────────────

/**
 * react-day-picker and date-fns, with the two calendars built on them — the
 * booking calendar in the detail panel and the "When" filter's calendar.
 */
export const calendarCode = onDemand(() => import('@/app/components/Calendars'));

/** Sanitises SVG markup before it is injected. */
export type SanitizeSvg = (markup: string) => string;

/**
 * DOMPurify, configured for the amenity icons: they are SVG markup stored on
 * the property document, so they are sanitised before they are injected.
 */
export const svgSanitizer = onDemand<SanitizeSvg>(() =>
  import('dompurify').then(({ default: DOMPurify }) => (markup: string) =>
    DOMPurify.sanitize(markup, { USE_PROFILES: { svg: true, svgFilters: true } }),
  ),
);

/**
 * Start fetching everything a detail panel needs.
 *
 * Called on intent (hovering, focusing or pressing a card or a pin) and again
 * when a panel opens, so the download overlaps with the visitor's own
 * movement and with the fetch of the property document instead of following
 * them. Idempotent.
 */
export function preloadPropertyDetail(): void {
  calendarCode.preload();
  svgSanitizer.preload();
}
