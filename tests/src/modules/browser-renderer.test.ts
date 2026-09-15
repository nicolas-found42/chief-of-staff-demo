import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { playwrightBrowserRenderer } from "../../../apps/server/src/source-adapters/browser";

const browser = vi.hoisted(() => ({
  close: vi.fn(),
  newContext: vi.fn(),
  newPage: vi.fn(),
  route: vi.fn(),
  routeWebSocket: vi.fn(),
}));
const launcher = vi.hoisted(() => ({ launch: vi.fn() }));
vi.mock("../../../apps/server/node_modules/playwright-core", () => ({ chromium: launcher }));
const navigationError = () =>
  new Error(
    "page.evaluate: Unable to retrieve content because the page is navigating and changing the content.",
  );

beforeEach(() => {
  vi.resetAllMocks();
  launcher.launch.mockResolvedValue(browser);
});
afterEach(() => vi.useRealTimers());

function pageFixture() {
  const page = {
    goto: vi.fn(async () => ({ status: () => 200 })),
    waitForLoadState: vi.fn(async () => undefined),
    evaluate: vi.fn(async () => "<html><body>Ready</body></html>"),
    url: () => "https://example.com/landing",
  };
  browser.newContext.mockResolvedValue(browser);
  browser.newPage.mockResolvedValue(page);
  return page;
}

describe("public browser rendering", () => {
  it("fails closed when the mandatory network sandbox cannot launch", async () => {
    launcher.launch.mockRejectedValueOnce(new Error("Browser network sandbox unavailable."));
    await expect(playwrightBrowserRenderer()("https://example.com")).rejects.toThrow(
      "sandbox unavailable",
    );
    expect(browser.newContext).not.toHaveBeenCalled();
    expect(launcher.launch).toHaveBeenCalledWith(
      expect.objectContaining({ executablePath: "/usr/local/bin/browser-network-sandbox" }),
    );
    pageFixture();
    await expect(playwrightBrowserRenderer()("https://example.com")).resolves.toMatchObject({
      status: 200,
    });
  });

  it("disables browser channels that do not belong to anonymous HTTP reading", async () => {
    pageFixture();
    await playwrightBrowserRenderer()("https://example.com");
    expect(browser.newContext).toHaveBeenCalledWith({
      serviceWorkers: "block",
      acceptDownloads: false,
    });
    expect(browser.routeWebSocket).toHaveBeenCalledWith("**/*", expect.any(Function));
    expect(browser.route).toHaveBeenCalledWith("**/*", expect.any(Function));
  });

  it("rejects request 101 before joining the full resource queue", async () => {
    const page = pageFixture();
    const routes = [];
    const fixtureRoute = () => ({
      request: () => ({
        url: () => "https://example.com/asset",
        method: () => "GET",
        headers: () => ({}),
        postDataBuffer: () => null,
        isNavigationRequest: () => false,
      }),
      abort: vi.fn(async () => undefined),
      fulfill: vi.fn(async () => undefined),
    });
    let dispatch!: (route: ReturnType<typeof fixtureRoute>) => Promise<void>;
    browser.route.mockImplementation((_pattern, handler) => {
      dispatch = handler;
    });
    let releaseResources!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseResources = resolve;
    });
    const fetchResource = vi.fn(async () => {
      await gate;
      return { status: 200, headers: {}, body: Buffer.from("asset") };
    });
    let finishNavigation!: () => void;
    page.goto.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishNavigation = () => resolve({ status: () => 200 });
        }),
    );
    const outcome = playwrightBrowserRenderer(fetchResource)("https://example.com").catch(
      (error: unknown) => error,
    );
    await vi.waitFor(() => expect(page.goto).toHaveBeenCalled());
    for (let i = 0; i < 100; i++) routes.push(dispatch(fixtureRoute()));
    const excess = fixtureRoute();
    routes.push(dispatch(excess));
    try {
      await Promise.resolve();
      expect(fetchResource).toHaveBeenCalledTimes(8);
      expect(excess.abort).toHaveBeenCalledWith("blockedbyclient");
    } finally {
      releaseResources();
      finishNavigation();
      await Promise.all(routes);
      expect(await outcome).toMatchObject({ code: "ERR_SOURCE_BODY_LIMIT" });
    }
  });

  it("reads the ready document without waiting for unrelated pending resources", async () => {
    const page = pageFixture();
    let dispatch!: (route: unknown) => Promise<void>;
    browser.route.mockImplementation((_pattern, handler) => {
      dispatch = handler;
    });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const fetchResource = vi.fn(async () => {
      await gate;
      return { status: 200, headers: {}, body: Buffer.from("background resource") };
    });
    const route = {
      request: () => ({
        url: () => "https://example.com/background",
        method: () => "GET",
        headers: () => ({}),
        postDataBuffer: () => null,
        isNavigationRequest: () => false,
      }),
      abort: vi.fn(async () => undefined),
      fulfill: vi.fn(async () => undefined),
    };
    let resource!: Promise<void>;
    page.goto.mockImplementationOnce(async () => {
      resource = dispatch(route);
      return { status: () => 200 };
    });
    const result = playwrightBrowserRenderer(fetchResource)("https://example.com");
    try {
      await vi.waitFor(() => expect(page.evaluate).toHaveBeenCalled(), { timeout: 100 });
    } finally {
      release();
      await resource;
      await result;
    }
    expect(browser.close).toHaveBeenCalledOnce();
  });

  it("rejects overlapping renders and releases admission after cleanup", async () => {
    const page = pageFixture();
    let finish!: () => void;
    page.goto.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = () => resolve({ status: () => 200 });
        }),
    );
    const first = playwrightBrowserRenderer()("https://example.com");
    await vi.waitFor(() => expect(page.goto).toHaveBeenCalled());
    await expect(playwrightBrowserRenderer()("https://example.com")).rejects.toThrow("busy");
    finish();
    await first;
    await expect(playwrightBrowserRenderer()("https://example.com")).resolves.toMatchObject({
      status: 200,
    });
  });

  it("reads the landing document when a navigation interrupts the first snapshot", async () => {
    const page = pageFixture();
    page.evaluate.mockRejectedValueOnce(navigationError());

    await expect(playwrightBrowserRenderer()("https://example.com")).resolves.toMatchObject({
      url: "https://example.com/landing",
      status: 200,
      body: "<html><body>Ready</body></html>",
    });
    expect(page.goto).toHaveBeenCalledTimes(1);
    expect(page.evaluate).toHaveBeenCalledTimes(2);
    expect(browser.close).toHaveBeenCalledOnce();
  });

  it("retries the actual evaluate execution-context navigation race", async () => {
    const page = pageFixture();
    page.evaluate.mockRejectedValueOnce(
      new Error(
        "page.evaluate: Execution context was destroyed, most likely because of a navigation",
      ),
    );
    await expect(playwrightBrowserRenderer()("https://example.com")).resolves.toMatchObject({
      status: 200,
    });
    expect(page.evaluate).toHaveBeenCalledTimes(2);
  });

  it("stops repeated navigations at the original rendering deadline", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const page = pageFixture();
    page.evaluate.mockImplementation(async () => {
      vi.setSystemTime(Date.now() + 10_000);
      throw navigationError();
    });

    await expect(playwrightBrowserRenderer()("https://example.com")).rejects.toMatchObject({
      name: "AbortError",
    });
    expect(page.evaluate).toHaveBeenCalledTimes(2);
    expect(browser.close).toHaveBeenCalledOnce();
  });

  it("uses only the remaining navigation budget when waiting for the landing page", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const page = pageFixture();
    page.goto.mockImplementation(async () => {
      vi.setSystemTime(12_000);
      return { status: () => 200 };
    });
    page.waitForLoadState.mockRejectedValue(
      Object.assign(new Error("Timed out"), { name: "TimeoutError" }),
    );

    await expect(playwrightBrowserRenderer()("https://example.com")).rejects.toMatchObject({
      name: "AbortError",
    });
    expect(page.waitForLoadState).toHaveBeenCalledWith("domcontentloaded", { timeout: 3_000 });
    expect(page.evaluate).not.toHaveBeenCalled();
    expect(browser.close).toHaveBeenCalledOnce();
  });

  it("does not retry unrelated snapshot failures", async () => {
    const page = pageFixture();
    page.evaluate.mockRejectedValue(new Error("Browser closed"));

    await expect(playwrightBrowserRenderer()("https://example.com")).rejects.toThrow(
      "Browser closed",
    );
    expect(page.evaluate).toHaveBeenCalledOnce();
    expect(browser.close).toHaveBeenCalledOnce();
  });

  it("reports a load timeout as an aborted collection and closes the browser", async () => {
    const page = pageFixture();
    page.goto.mockRejectedValue(Object.assign(new Error("Timed out"), { name: "TimeoutError" }));

    await expect(playwrightBrowserRenderer()("https://example.com")).rejects.toMatchObject({
      name: "AbortError",
    });
    expect(browser.close).toHaveBeenCalledOnce();
  });

  it("still rejects an oversized rendered document", async () => {
    const page = pageFixture();
    page.evaluate.mockRejectedValue(new Error("Rendered page exceeded the 5 MB collection limit."));

    await expect(playwrightBrowserRenderer()("https://example.com")).rejects.toMatchObject({
      code: "ERR_SOURCE_BODY_LIMIT",
    });
    expect(browser.close).toHaveBeenCalledOnce();
  });
});
