"use client";

import { useEffect, useRef, useState } from 'react';

/**
 * True once the element has come within `margin` of the viewport.
 *
 * ── Why this exists rather than `loading="lazy"` ──
 * Chrome's native lazy-loading threshold is not a fixed margin: it scales
 * with the connection, and on a slow one it reaches thousands of pixels past
 * the viewport. That is the right default for a blog, and the wrong one here
 * — it fetched all 15 homepage cards and all 35 cards behind an open detail
 * panel. An IntersectionObserver with an explicit margin is the only way to
 * say "a screen ahead, and no further" and have it mean that.
 *
 * ── One-way ──
 * Once true it stays true. An image that has been requested is in the
 * browser cache; un-rendering it on scroll-away would throw that away and
 * re-request it on the way back.
 *
 * ── Degradation ──
 * Where IntersectionObserver is missing, this returns true immediately, so
 * every image loads as it did before. A missing optimisation is acceptable;
 * a missing image is not.
 */
export function useNearViewport<T extends Element>(
  margin: string,
  /** Skip observation entirely and report visible from the first render. */
  eager = false,
): [React.RefObject<T | null>, boolean] {
  const ref = useRef<T>(null);
  const [near, setNear] = useState(eager);

  useEffect(() => {
    if (near) return;

    const el = ref.current;
    if (!el || typeof IntersectionObserver === 'undefined') {
      // The one place this hook updates state outside an observer callback.
      // It cannot be decided during render: on the server
      // `IntersectionObserver` is always undefined, so a render-time check
      // would reveal every image in the SSR HTML and defeat the gate, and
      // reading it lazily into `useState` would differ between server and
      // client and break hydration. It runs at most once per element, in a
      // browser old enough to lack IntersectionObserver, where loading the
      // image is the only safe outcome.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setNear(true);
      return;
    }

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setNear(true);
          observer.disconnect();
        }
      },
      // `root: null` is the viewport, which is correct even though the list
      // scrolls inside its own container: an element scrolling within that
      // container still changes its intersection with the viewport.
      { root: null, rootMargin: margin, threshold: 0 },
    );

    observer.observe(el);
    return () => observer.disconnect();
  }, [margin, near]);

  return [ref, near];
}
