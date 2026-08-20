/* PROTOTYPE — throwaway. Lives on branch prototype/home-variants, never main.
   Answers .scratch/shell-home/issues/01-what-home-shows.md */
import { useEffect } from "react";
import { useSearchParams } from "react-router-dom";

const EDITABLE = new Set(["INPUT", "TEXTAREA", "SELECT"]);

export function PrototypeSwitcher({
  variants,
  names,
  states,
}: {
  variants: string[];
  names: Record<string, string>;
  states: string[];
}) {
  const [params, setParams] = useSearchParams();
  const variant = params.get("variant") ?? variants[0];
  const state = params.get("state") ?? states[0];

  const step = (delta: number) => {
    const i = variants.indexOf(variant);
    const next = variants[(i + delta + variants.length) % variants.length];
    const updated = new URLSearchParams(params);
    updated.set("variant", next);
    setParams(updated, { replace: true });
  };

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const el = document.activeElement;
      if (el && (EDITABLE.has(el.tagName) || (el as HTMLElement).isContentEditable)) {
        return;
      }
      if (event.key === "ArrowLeft") step(-1);
      if (event.key === "ArrowRight") step(1);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  // A stray merge to main must not ship this bar.
  if (import.meta.env.PROD) {
    return null;
  }

  return (
    <div
      style={{
        position: "fixed",
        bottom: 16,
        left: "50%",
        transform: "translateX(-50%)",
        display: "flex",
        alignItems: "center",
        gap: 12,
        background: "#111",
        color: "#fff",
        padding: "8px 12px",
        borderRadius: 999,
        boxShadow: "0 4px 20px rgba(0,0,0,.35)",
        fontFamily: "system-ui, sans-serif",
        fontSize: 14,
        zIndex: 9999,
      }}
    >
      <button type="button" onClick={() => step(-1)} style={btn} aria-label="Previous variant">
        ←
      </button>
      <strong style={{ minWidth: 210, textAlign: "center" }}>
        {variant} — {names[variant]}
      </strong>
      <button type="button" onClick={() => step(1)} style={btn} aria-label="Next variant">
        →
      </button>
      <span style={{ opacity: 0.4 }}>|</span>
      {states.map((s) => (
        <button
          key={s}
          type="button"
          onClick={() => {
            const updated = new URLSearchParams(params);
            updated.set("state", s);
            setParams(updated, { replace: true });
          }}
          style={{ ...btn, background: s === state ? "#fff" : "transparent", color: s === state ? "#111" : "#fff" }}
        >
          {s}
        </button>
      ))}
    </div>
  );
}

const btn: React.CSSProperties = {
  background: "transparent",
  color: "inherit",
  border: "1px solid rgba(255,255,255,.4)",
  borderRadius: 999,
  padding: "2px 10px",
  cursor: "pointer",
  font: "inherit",
};
