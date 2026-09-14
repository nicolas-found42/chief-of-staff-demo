import { fetch, type Dispatcher } from "undici";
import { assertPublicHttpUrl, createSourceHttpDispatcher } from "./http.js";
import { readSourceBytes, sourceBodyLimitError } from "./source-body.js";

export interface BrowserResource {
  status: number;
  headers: Record<string, string>;
  body: Buffer;
}

/** Anonymous browser resources use the same connection-time address policy as
 * HTTP extraction. Redirects return to Chromium to preserve document origin;
 * the next intercepted hop is independently guarded before any socket opens. */
export function createBrowserResourceFetch(dispatcher: Dispatcher = createSourceHttpDispatcher()) {
  return async (
    value: string,
    method: string,
    headers: Record<string, string>,
    body: Buffer | null,
    signal: AbortSignal,
    navigation = false,
  ): Promise<BrowserResource> => {
    let url = assertPublicHttpUrl(value);
    if (!["GET", "HEAD", "POST", "OPTIONS"].includes(method)) {
      throw new Error("Browser source request method is unsupported.");
    }
    if (body && body.byteLength > 5_000_000) {
      throw sourceBodyLimitError();
    }
    const forwarded: Record<string, string> = {};
    for (const name of [
      "accept",
      "accept-language",
      "content-type",
      "user-agent",
      "origin",
      "access-control-request-method",
      "access-control-request-headers",
    ]) {
      if (headers[name]) forwarded[name] = headers[name];
    }
    for (let redirects = 0; ; redirects += 1) {
      const response = await fetch(url, {
        method,
        headers: forwarded,
        ...(body ? { body } : {}),
        signal,
        dispatcher,
        redirect: "manual",
        credentials: "omit",
      });
      const location = response.headers.get("location");
      if ([301, 302, 303, 307, 308].includes(response.status) && location !== null) {
        await response.body?.cancel();
        const target = assertPublicHttpUrl(new URL(location, url).toString());
        if (redirects >= 20) throw new Error("Browser source exceeded the redirect limit.");
        if (navigation) {
          if (method !== "GET")
            throw new Error("Browser source form navigation redirects are unsupported.");
          return {
            status: response.status,
            headers: { location: target.toString() },
            body: Buffer.alloc(0),
          };
        }
        if (
          response.status === 303 ||
          ((response.status === 301 || response.status === 302) && method === "POST")
        ) {
          method = "GET";
          body = null;
          delete forwarded["content-type"];
        }
        url = target;
        continue;
      }
      const bytes = await readSourceBytes(response.body);
      const responseHeaders = Object.fromEntries(response.headers);
      // Undici has already decompressed the body. Authentication/storage and
      // reporting directives do not belong to this anonymous reading context.
      for (const name of [
        "content-encoding",
        "content-length",
        "set-cookie",
        "set-cookie2",
        "www-authenticate",
        "proxy-authenticate",
        "report-to",
        "reporting-endpoints",
        "nel",
      ])
        delete responseHeaders[name];
      return { status: response.status, headers: responseHeaders, body: bytes };
    }
  };
}
