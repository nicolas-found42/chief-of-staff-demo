/**
 * PROTOTYPE — throwaway variant switcher, not production UI.
 * "Three variants of Home, switchable via `?variant=`, on the existing `/` route."
 * Delete with the losing variants when one wins; never ship to prod
 * (returns null under Vite production builds).
 */
import { useEffect } from "react";
import { useSearchParams } from "react-router-dom";

const PROTOTYPE_VARIANTS = [
  { key: "current", name: "Current" },
  { key: "a", name: "Airy Bento" },
  { key: "b", name: "Command Deck" },
  { key: "c", name: "Editorial Warmth" },
];

export function PrototypeSwitcher({ current }: { current: string }) {
  // Hidden in production builds so a stray merge can't ship the bar.
  if (import.meta.env.PROD) return null;
  return <PrototypeSwitcherInner current={current} />;
}

function PrototypeSwitcherInner({ current }: { current: string }) {
  const [, setSearchParams] = useSearchParams();
  const index = Math.max(
    0,
    PROTOTYPE_VARIANTS.findIndex((v) => v.key === current),
  );
  const go = (dir: 1 | -1) => {
    const next =
      PROTOTYPE_VARIANTS[(index + dir + PROTOTYPE_VARIANTS.length) % PROTOTYPE_VARIANTS.length]!;
    setSearchParams(
      (prev) => {
        const p = new URLSearchParams(prev);
        p.set("variant", next.key);
        return p;
      },
      { replace: true },
    );
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable)) {
        return;
      }
      if (e.key === "ArrowLeft") go(-1);
      if (e.key === "ArrowRight") go(1);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [index]);

  const label = PROTOTYPE_VARIANTS[index]!;
  return (
    <div
      className="prototype-switcher"
      role="toolbar"
      aria-label="Prototype variant switcher (throwaway)"
    >
      <button type="button" onClick={() => go(-1)} aria-label="Previous variant">
        ←
      </button>
      <span className="prototype-switcher-label">
        {label.key} ({label.name})
      </span>
      <button type="button" onClick={() => go(1)} aria-label="Next variant">
        →
      </button>
    </div>
  );
}
