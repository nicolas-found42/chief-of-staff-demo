// @vitest-environment jsdom
import { act, createElement, Suspense, use, useLayoutEffect } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { expect, test, vi } from "vitest";
import { useReadingPosition } from "../../../apps/web/src/useReadingPosition";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

test.each(["replacement", "suspension"])(
  "leaving via %s cannot save the next page's clamped scroll position",
  async (mode) => {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const frames: FrameRequestCallback[] = [];
    let scrollY = 0;
    vi.spyOn(window, "scrollY", "get").mockImplementation(() => scrollY);
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      frames.push(callback);
      return frames.length;
    });
    vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => {});
    const scrollTo = vi.spyOn(window, "scrollTo").mockImplementation(() => {});
    sessionStorage.clear();
    function History() {
      useReadingPosition(true);
      return createElement("div", null, "History");
    }
    function NextPage() {
      useLayoutEffect(() => {
        // Browser layout clamps scrolling when a shorter page replaces History,
        // before passive-effect cleanup is guaranteed to remove its listeners.
        scrollY = 0;
        window.dispatchEvent(new Event("scroll"));
      }, []);
      return createElement("div", null, "Meeting loading");
    }
    const pending = new Promise<never>(() => {});
    function Gate({ suspended }: { suspended: boolean }) {
      if (suspended) use(pending);
      return null;
    }
    function view(showNext: boolean) {
      return createElement(
        MemoryRouter,
        null,
        mode === "replacement"
          ? createElement(showNext ? NextPage : History)
          : createElement(
              Suspense,
              { fallback: createElement(NextPage) },
              createElement(Gate, { suspended: showNext }),
              createElement(History),
            ),
      );
    }
    try {
      await act(async () => root.render(view(false)));
      frames.splice(0).forEach((callback) => callback(0));
      scrollY = 3440;
      window.dispatchEvent(new Event("scroll"));
      expect(JSON.parse(sessionStorage.getItem("meeting-position:default")!)).toEqual({
        y: 3440,
        focus: null,
      });
      await act(async () => root.render(view(true)));
      expect(JSON.parse(sessionStorage.getItem("meeting-position:default")!)).toEqual({
        y: 3440,
        focus: null,
      });
      await act(async () => root.render(view(false)));
      frames.splice(0).forEach((callback) => callback(0));
      expect(scrollTo).toHaveBeenLastCalledWith({ top: 3440, behavior: "instant" });
    } finally {
      await act(async () => root.unmount());
      container.remove();
      sessionStorage.clear();
      vi.restoreAllMocks();
    }
  },
);
