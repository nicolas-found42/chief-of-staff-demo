import { createHash } from "node:crypto";
import { isIP } from "node:net";

export interface PublicHttpResponse {
  url: string;
  status: number;
  contentType: string | null;
  etag: string | null;
  lastModified: string | null;
  body: string;
}

export type PublicHttpFetch = (
  url: string,
  options?: { etag?: string | null; lastModified?: string | null },
) => Promise<PublicHttpResponse>;

function privateIpv4(hostname: string): boolean {
  const octets = hostname.split(".").map(Number);
  if (octets.length !== 4 || octets.some((part) => !Number.isInteger(part))) {
    return false;
  }
  const [a, b] = octets as [number, number, number, number];
  return (
    a === 10 ||
    a === 127 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    a === 0
  );
}

export function assertPublicHttpUrl(value: string): URL {
  const url = new URL(value);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Source Targets must use public HTTP or HTTPS URLs.");
  }
  const hostname = url.hostname.toLowerCase();
  if (
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname.endsWith(".local") ||
    privateIpv4(hostname) ||
    (isIP(hostname) === 6 &&
      (hostname === "::1" ||
        hostname.startsWith("fc") ||
        hostname.startsWith("fd") ||
        hostname.startsWith("fe80")))
  ) {
    throw new Error("Source Targets must resolve to a public host.");
  }
  url.username = "";
  url.password = "";
  url.hash = "";
  return url;
}

export const publicHttpFetch: PublicHttpFetch = async (value, options = {}) => {
  const url = assertPublicHttpUrl(value);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20_000);
  try {
    const headers: Record<string, string> = {
      accept:
        "text/html, application/rss+xml, application/atom+xml, application/xml;q=0.9, text/xml;q=0.9",
      "user-agent": "Found42-Content-Scout/1.0 (+public-source-monitor)",
    };
    if (options.etag) headers["if-none-match"] = options.etag;
    if (options.lastModified) headers["if-modified-since"] = options.lastModified;
    const response = await fetch(url, {
      headers,
      redirect: "follow",
      signal: controller.signal,
      credentials: "omit",
    });
    const body = await response.text();
    if (body.length > 5_000_000) {
      throw new Error("Source response exceeded the 5 MB collection limit.");
    }
    return {
      url: response.url || url.toString(),
      status: response.status,
      contentType: response.headers.get("content-type"),
      etag: response.headers.get("etag"),
      lastModified: response.headers.get("last-modified"),
      body,
    };
  } finally {
    clearTimeout(timer);
  }
};

export function responseHash(body: string): string {
  return createHash("sha256").update(body).digest("hex");
}

export function canonicalUrl(value: string): string {
  const url = new URL(value);
  url.hash = "";
  for (const key of [...url.searchParams.keys()]) {
    if (/^(utm_|fbclid$|gclid$)/i.test(key)) {
      url.searchParams.delete(key);
    }
  }
  return url.toString();
}
