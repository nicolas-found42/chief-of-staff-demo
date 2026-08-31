import { chromium } from "playwright-core";
import { assertPublicHttpUrl } from "../../../source-adapters/http.js";

export interface BrowserRenderResult {
  url: string;
  contentType: string;
  status: number;
  body: string;
}

export type BrowserRenderer = (url: string) => Promise<BrowserRenderResult>;

const BROWSER_NAVIGATION_TIMEOUT_MS = 15_000;
const BROWSER_COLLECTION_LIMIT_BYTES = 5_000_000;

/**
 * The bounded public browser route behind the Website Source Adapter. It
 * renders exactly one public URL in a fresh anonymous headless Chromium
 * context: no cookies, no persisted storage state, no authentication, no
 * CAPTCHA handling and no stealth flags. Launching and closing a browser per
 * request keeps the fallback isolated from every other adapter and bounded in
 * time and body size.
 */
export function playwrightBrowserRenderer(): BrowserRenderer {
  return async (value) => {
    const url = assertPublicHttpUrl(value);
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage();
      let status = 200;
      try {
        const navigation = await page.goto(url.toString(), {
          waitUntil: "domcontentloaded",
          timeout: BROWSER_NAVIGATION_TIMEOUT_MS,
        });
        status = navigation?.status() ?? 200;
      } catch (error) {
        if (error instanceof Error && error.name === "TimeoutError") {
          const timeout = new Error(
            `Browser rendering timed out after ${BROWSER_NAVIGATION_TIMEOUT_MS / 1000} seconds.`,
          );
          timeout.name = "AbortError";
          throw timeout;
        }
        throw error;
      }
      const body = await page.content();
      if (Buffer.byteLength(body, "utf8") > BROWSER_COLLECTION_LIMIT_BYTES) {
        throw new Error("Rendered page exceeded the 5 MB collection limit.");
      }
      return { url: page.url(), contentType: "text/html", status, body };
    } finally {
      await browser.close();
    }
  };
}
