import { useEffect, useRef } from "react";
import { useLocation } from "react-router-dom";

/** The router's key for the entry the browser itself loaded. */
const INITIAL_ENTRY = "default";

/**
 * Moves focus to the page heading when the app navigates to a route, so
 * keyboard and screen reader users continue from the new page instead of being
 * left on the link they just activated with nothing announced (WCAG 2.4.3).
 *
 * Attach the returned ref to an `<h1 tabIndex={-1}>`.
 *
 * The entry the browser loaded is left alone: focus already sits at the top of
 * the document there, ahead of the skip link, and moving it would put that link
 * permanently out of reach. RunDetailPage keeps its own copy of this pattern —
 * its heading has to wait for the run to load and must not be re-focused by the
 * 3s poll.
 */
export function usePageFocus<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const { key } = useLocation();
  useEffect(() => {
    if (key !== INITIAL_ENTRY) {
      ref.current?.focus();
    }
  }, [key]);
  return ref;
}
