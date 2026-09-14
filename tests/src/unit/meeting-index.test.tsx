// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MeetingBriefIndex } from "@chief-of-staff-demo/shared";
import { useMeetingIndex } from "../../../apps/web/src/useMeetingIndex";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

function deferred<T>() {
  return Promise.withResolvers<T>();
}

function projection(summary: string): MeetingBriefIndex {
  return {
    briefs: [],
    cancellations: [],
    upcoming: [
      {
        occurrenceKey: "meeting",
        eventId: "event",
        occurrenceId: "occurrence",
        version: "1",
        summary,
        startAt: "2026-09-15T12:00:00Z",
        dueAt: "2026-09-15T11:00:00Z",
      },
    ],
  };
}

let mounted: { root: Root; container: HTMLDivElement } | null = null;
async function mount(
  fetch: () => Promise<MeetingBriefIndex>,
  prepare = vi.fn(async (_key: string) => {}),
) {
  let current: ReturnType<typeof useMeetingIndex> | undefined;
  function Harness() {
    current = useMeetingIndex(fetch, prepare);
    return null;
  }
  const container = document.createElement("div");
  const root = createRoot(container);
  mounted = { root, container };
  await act(async () => root.render(createElement(Harness)));
  return () => {
    if (!current) throw new Error("Hook has not rendered");
    return current;
  };
}

afterEach(async () => {
  await act(async () => mounted?.root.unmount());
  mounted?.container.remove();
  mounted = null;
  vi.useRealTimers();
});

describe("Meeting Brief projection recovery", () => {
  it("ignores a read that finishes after a newer refresh", async () => {
    const old = deferred<MeetingBriefIndex>();
    const fetch = vi
      .fn<() => Promise<MeetingBriefIndex>>()
      .mockReturnValueOnce(old.promise)
      .mockResolvedValue(projection("Current"));
    const state = await mount(fetch);
    await act(async () => state().refresh());
    await act(async () => old.resolve(projection("Stale")));
    expect(state().index?.upcoming[0]?.summary).toBe("Current");
  });

  it("does not show an obsolete read error after a newer refresh succeeds", async () => {
    const old = deferred<MeetingBriefIndex>();
    const fetch = vi
      .fn<() => Promise<MeetingBriefIndex>>()
      .mockReturnValueOnce(old.promise)
      .mockResolvedValue(projection("Current"));
    const state = await mount(fetch);
    await act(async () => state().refresh());
    await act(async () => old.reject(new Error("Old connection failure")));
    expect(state().error).toBeNull();
  });

  it("guards rapid Prepare now calls and keeps busy until preparation finishes", async () => {
    const pending = deferred<void>();
    const prepare = vi.fn((_key: string) => pending.promise);
    const state = await mount(
      vi.fn(async () => projection("Current")),
      prepare,
    );
    let preparation: Promise<void> | undefined;
    await act(async () => {
      preparation = state().prepareNow("meeting");
      void state().prepareNow("meeting");
    });
    expect(prepare).toHaveBeenCalledTimes(1);
    await act(async () => state().refresh());
    expect(state().busy).toBe(true);
    await act(async () => {
      pending.resolve();
      await preparation;
    });
    expect(state().busy).toBe(false);
  });

  it("keeps preparation failure visible through a successful background poll", async () => {
    vi.useFakeTimers();
    const prepare = vi.fn(async (_key: string) => {
      throw new Error("Preparation failed");
    });
    const fetch = vi.fn(async () => projection("Current"));
    const state = await mount(fetch, prepare);
    await act(async () => state().prepareNow("meeting"));
    expect(state().error).toBe("Preparation failed");
    await act(async () => vi.advanceTimersByTimeAsync(5000));
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(state().error).toBe("Preparation failed");
  });

  it("keeps the newer read busy when an older read settles first", async () => {
    const old = deferred<MeetingBriefIndex>();
    const newer = deferred<MeetingBriefIndex>();
    const fetch = vi
      .fn<() => Promise<MeetingBriefIndex>>()
      .mockReturnValueOnce(old.promise)
      .mockReturnValueOnce(newer.promise);
    const state = await mount(fetch);
    let refresh: Promise<void> | undefined;
    await act(async () => {
      refresh = state().refresh();
    });
    await act(async () => old.resolve(projection("Old")));
    expect(state().busy).toBe(true);
    await act(async () => {
      newer.resolve(projection("New"));
      await refresh;
    });
    expect(state().busy).toBe(false);
    expect(state().index?.upcoming[0]?.summary).toBe("New");
  });

  it("does not accumulate polls while a read is pending", async () => {
    vi.useFakeTimers();
    const pending = deferred<MeetingBriefIndex>();
    const fetch = vi
      .fn<() => Promise<MeetingBriefIndex>>()
      .mockResolvedValueOnce(projection("Current"))
      .mockReturnValue(pending.promise);
    await mount(fetch);
    await act(async () => vi.advanceTimersByTimeAsync(20_000));
    expect(fetch).toHaveBeenCalledTimes(2);
    await act(async () => pending.resolve(projection("Updated")));
  });

  it("retains the last projection on read failure and recovers on retry", async () => {
    const fetch = vi
      .fn<() => Promise<MeetingBriefIndex>>()
      .mockResolvedValueOnce(projection("Current"))
      .mockRejectedValueOnce(new Error("Connection lost"))
      .mockResolvedValueOnce(projection("Recovered"));
    const state = await mount(fetch);
    await act(async () => state().refresh());
    expect(state().index?.upcoming[0]?.summary).toBe("Current");
    expect(state().error).toBe("Connection lost");
    expect(state().busy).toBe(false);
    await act(async () => state().refresh());
    expect(state().index?.upcoming[0]?.summary).toBe("Recovered");
    expect(state().error).toBeNull();
  });

  it("clears a preparation error when the owner retries successfully", async () => {
    const prepare = vi
      .fn<(key: string) => Promise<void>>()
      .mockRejectedValueOnce(new Error("Preparation failed"))
      .mockResolvedValueOnce();
    const state = await mount(
      vi.fn(async () => projection("Current")),
      prepare,
    );
    await act(async () => state().prepareNow("meeting"));
    expect(state().error).toBe("Preparation failed");
    await act(async () => state().prepareNow("meeting"));
    expect(prepare).toHaveBeenCalledTimes(2);
    expect(state().error).toBeNull();
    expect(state().busy).toBe(false);
  });

  it("keeps preparation busy even when a concurrent refresh completes", async () => {
    const pending = deferred<void>();
    const state = await mount(
      vi.fn(async () => projection("Current")),
      vi.fn((_key: string) => pending.promise),
    );
    let preparation: Promise<void> | undefined;
    await act(async () => {
      preparation = state().prepareNow("meeting");
    });
    await act(async () => state().refresh());
    expect(state().busy).toBe(true);
    await act(async () => {
      pending.resolve();
      await preparation;
    });
    expect(state().busy).toBe(false);
  });

  it("does not start a follow-up read when preparation finishes after leaving the page", async () => {
    const pending = deferred<void>();
    const fetch = vi.fn(async () => projection("Current"));
    const state = await mount(
      fetch,
      vi.fn((_key: string) => pending.promise),
    );
    let preparation: Promise<void> | undefined;
    await act(async () => {
      preparation = state().prepareNow("meeting");
    });
    await act(async () => mounted?.root.unmount());
    mounted = null;
    await act(async () => {
      pending.resolve();
      await preparation;
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
