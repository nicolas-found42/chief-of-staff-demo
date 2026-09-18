import { chromium, type Page } from "playwright-core";
import { assertPublicHttpUrl } from "./http.js";
import { sourceBodyLimitError } from "./source-body.js";
import { createBrowserResourceFetch } from "./browser-network.js";

export interface BrowserRenderResult {
  url: string;
  contentType: string;
  status: number;
  body: string;
}

export type BrowserRenderer = (url: string) => Promise<BrowserRenderResult>;

const BROWSER_NAVIGATION_TIMEOUT_MS = 15_000;
const BROWSER_COLLECTION_LIMIT_BYTES = 5_000_000;

function renderingTimeout(): Error {
  return Object.assign(
    new Error(`Browser rendering timed out after ${BROWSER_NAVIGATION_TIMEOUT_MS / 1000} seconds.`),
    { name: "AbortError" },
  );
}

async function readLandingDocument(
  page: Page,
  deadline: number,
  expectedUrl: () => string | undefined,
): Promise<string> {
  for (;;) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw renderingTimeout();
    const target = expectedUrl();
    if (target && page.url() !== target)
      await page.waitForURL(target, { timeout: remaining, waitUntil: "domcontentloaded" });
    await page.waitForLoadState("domcontentloaded", {
      timeout: Math.max(1, deadline - Date.now()),
    });
    try {
      return await page.evaluate((limit) => {
        const html = document.documentElement.outerHTML;
        if (new TextEncoder().encode(html).byteLength > limit) {
          throw new Error("Rendered page exceeded the 5 MB collection limit.");
        }
        return `<!DOCTYPE html>${html}`;
      }, BROWSER_COLLECTION_LIMIT_BYTES - 15);
    } catch (error) {
      // A client-side redirect can destroy the document after DOMContentLoaded.
      // Retry that race only, without giving each redirect a fresh time budget.
      if (
        !(error instanceof Error) ||
        (!error.message.includes(
          "Unable to retrieve content because the page is navigating and changing the content.",
        ) &&
          !error.message.includes("Execution context was destroyed"))
      )
        throw error;
    }
  }
}

const resourceFetch = createBrowserResourceFetch();
/* Process-global FIFO admission, not per-instance state: the composition shell
   creates several renderer instances (person research, content portfolio,
   LinkedIn route) that all share the one anonymous sandboxed Chromium. An
   instance-local flag would only serialize within one instance (#417 F9), so
   overlapping leads shed as "busy". Queued renders wait in arrival order; a
   failed render releases its slot through the same chain, so one failure never
   poisons the queue. Each admitted render keeps its own navigation deadline —
   queueing time is not billed to it. */
let renderTail: Promise<unknown> = Promise.resolve();

/** Chromium cannot create IP sockets: the production launcher installs an
 * inherited Linux seccomp filter before exec. All supported HTTP traffic is
 * fulfilled by the guarded Node transport. Missing launcher/filter fails closed.
 * One renderer and the container memory limit bound the independent browser
 * workload; response/DOM limits alone are not a whole-process memory guarantee. */
export function playwrightBrowserRenderer(fetchResource = resourceFetch): BrowserRenderer {
  return async (value) => {
    const url = assertPublicHttpUrl(value);
    const outcome = renderTail.then(() => renderOnce(url, fetchResource));
    /* The tail settles independently of the result: a rejected render must not
       fail the chain, or every queued render after it would die with it. */
    renderTail = outcome.catch(() => undefined);
    return outcome;
  };
}

async function renderOnce(
  url: URL,
  fetchResource: typeof resourceFetch,
): Promise<BrowserRenderResult> {
  const controller = new AbortController();
  const deadline = Date.now() + BROWSER_NAVIGATION_TIMEOUT_MS;
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  let failure: Error | undefined;
  let requestCount = 0;
  let navigationRedirects = 0;
  let mainDocumentStatus: number | undefined;
  let expectedMainDocument: string | undefined;
  let activeRequests = 0;
  let collectedBytes = 0;
  const pending = new Set<Promise<void>>();
  const resourceWaiters: (() => void)[] = [];
  const timer = setTimeout(() => {
    failure = renderingTimeout();
    controller.abort();
    void browser?.close().catch(() => undefined);
  }, BROWSER_NAVIGATION_TIMEOUT_MS);
  try {
    browser = await chromium.launch({
      headless: true,
      executablePath: "/usr/local/bin/browser-network-sandbox",
      timeout: BROWSER_NAVIGATION_TIMEOUT_MS,
      args: ["--disable-quic", "--disable-extensions"],
    });
    const context = await browser.newContext({ serviceWorkers: "block", acceptDownloads: false });
    await context.routeWebSocket("**/*", (socket) =>
      socket.close({ code: 1008, reason: "Browser source WebSockets are unsupported." }),
    );
    await context.route("**/*", (route) => {
      const operation = (async () => {
        requestCount += 1;
        if (requestCount > 100) {
          failure ??= sourceBodyLimitError();
          await route.abort("blockedbyclient").catch(() => undefined);
          return;
        }
        while (activeRequests >= 8)
          await new Promise<void>((resolve) => resourceWaiters.push(resolve));
        activeRequests += 1;
        try {
          if (collectedBytes >= 20_000_000) {
            throw sourceBodyLimitError();
          }
          const request = route.request();
          const response = await fetchResource(
            request.url(),
            request.method(),
            request.headers(),
            request.postDataBuffer(),
            controller.signal,
            request.isNavigationRequest(),
          );
          collectedBytes += response.body.byteLength;
          if (collectedBytes > 20_000_000) {
            throw sourceBodyLimitError();
          }
          if ([301, 302, 303, 307, 308].includes(response.status) && response.headers.location) {
            if (request.frame().parentFrame() === null)
              expectedMainDocument = response.headers.location;
            navigationRedirects += 1;
            if (navigationRedirects > 20)
              throw new Error("Browser source exceeded the redirect limit.");
            // Playwright routing only sees the first URL in an HTTP redirect
            // chain. A fresh document navigation is intercepted again and
            // keeps the actual landing origin, without permitting direct IP.
            const target = JSON.stringify(response.headers.location).replaceAll("<", "\\u003c");
            await route.fulfill({
              status: 200,
              contentType: "text/html",
              body: `<script>location.replace(${target})</script>`,
            });
          } else {
            if (request.isNavigationRequest() && request.frame().parentFrame() === null) {
              mainDocumentStatus = response.status;
              expectedMainDocument = request.url();
            }
            await route.fulfill(response);
          }
        } catch (error) {
          failure ??= error instanceof Error ? error : new Error("Browser source request failed.");
          await route.abort("blockedbyclient").catch(() => undefined);
        } finally {
          activeRequests -= 1;
          resourceWaiters.shift()?.();
        }
      })();
      pending.add(operation);
      void operation.finally(() => pending.delete(operation));
      return operation;
    });
    const page = await context.newPage();
    const navigation = await page.goto(url.toString(), {
      waitUntil: "domcontentloaded",
      timeout: Math.max(1, deadline - Date.now()),
    });
    // DOMContentLoaded is the reading boundary. Waiting for every background
    // resource lets analytics and speculative fetches exhaust the budget after
    // the source is ready. The finally block still cancels and drains them.
    const body = await readLandingDocument(page, deadline, () => expectedMainDocument);
    if (failure) throw failure;
    return {
      url: assertPublicHttpUrl(page.url()).toString(),
      contentType: "text/html",
      status: mainDocumentStatus ?? navigation?.status() ?? 200,
      body,
    };
  } catch (error) {
    if (failure) throw failure;
    if (error instanceof Error && error.message.includes("5 MB collection limit"))
      throw sourceBodyLimitError();
    if (error instanceof Error && error.name === "TimeoutError") throw renderingTimeout();
    throw error;
  } finally {
    clearTimeout(timer);
    controller.abort();
    await browser?.close();
    await Promise.allSettled(pending);
  }
}
