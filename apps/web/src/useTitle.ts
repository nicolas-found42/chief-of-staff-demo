import { useEffect } from "react";

const SUFFIX = "Transcript → Tasks";

/** Sets document.title for the current route (WCAG 2.4.2 Page Titled). */
export function useTitle(title: string | null): void {
  useEffect(() => {
    document.title = title ? `${title} · ${SUFFIX}` : SUFFIX;
  }, [title]);
}
