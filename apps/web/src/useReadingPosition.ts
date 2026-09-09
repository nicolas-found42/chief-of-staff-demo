import { useEffect } from "react";
import { NavigationType, useLocation, useNavigationType } from "react-router-dom";

/** Restore the originating history entry after its asynchronous content arrives. */
export function useReadingPosition(ready: boolean) {
  const { key } = useLocation();
  const navigation = useNavigationType();
  useEffect(() => {
    if (!ready) return;
    const storageKey = `meeting-position:${key}`;
    let saved: { y: number; focus: string | null } = { y: 0, focus: null };
    try {
      saved =
        (JSON.parse(sessionStorage.getItem(storageKey) ?? "null") as typeof saved | null) ?? saved;
    } catch {
      /* A damaged local preference never blocks reading. */
    }
    let restoring = navigation === NavigationType.Pop;
    const observer = new MutationObserver(() => restore());
    const restore = () => {
      if (!restoring) return;
      const focused = saved.focus ? document.getElementById(saved.focus) : null;
      focused?.focus({ preventScroll: true });
      window.scrollTo({ top: saved.y, behavior: "instant" });
      if ((!saved.focus || focused) && Math.abs(window.scrollY - saved.y) < 2) {
        restoring = false;
        observer.disconnect();
      }
    };
    const cancelRestore = () => {
      restoring = false;
      observer.disconnect();
    };
    if (restoring) observer.observe(document.body, { childList: true, subtree: true });
    const frame = requestAnimationFrame(restore);
    const scroll = () => {
      if (restoring) return;
      saved.y = window.scrollY;
      sessionStorage.setItem(storageKey, JSON.stringify(saved));
    };
    const focus = (event: FocusEvent) => {
      if (restoring || !(event.target instanceof HTMLElement) || !event.target.id) return;
      saved.focus = event.target.id;
      sessionStorage.setItem(storageKey, JSON.stringify(saved));
    };
    window.addEventListener("scroll", scroll, { passive: true });
    document.addEventListener("focusin", focus);
    document.addEventListener("pointerdown", cancelRestore, { once: true });
    document.addEventListener("keydown", cancelRestore, { once: true });
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      window.removeEventListener("scroll", scroll);
      document.removeEventListener("focusin", focus);
      document.removeEventListener("pointerdown", cancelRestore);
      document.removeEventListener("keydown", cancelRestore);
    };
  }, [key, navigation, ready]);
}
