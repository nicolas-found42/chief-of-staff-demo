/**
 * Portable path and text utilities. No node:* imports: usable in the browser.
 */

/** True when the path is absolute on any platform: a POSIX root, a Windows
 * drive-letter prefix, or a UNC prefix. Workspace-relative paths must reject
 * all three regardless of the host OS, so a drive path can never slip through
 * as relative. */
export function isAbsolutePath(p: string): boolean {
  return p.startsWith("/") || p.startsWith("\\\\") || /^[A-Za-z]:[\\/]/.test(p);
}

/** Lexically normalize to forward slashes: drop "." segments, resolve ".."
 * against the preceding segment, collapse duplicate separators. */
function normalizePortable(p: string): string {
  const parts: string[] = [];
  for (const part of p.replace(/\\/g, "/").split("/")) {
    if (part === "" || part === ".") {
      continue;
    }
    if (part === "..") {
      if (parts.length === 0 || parts[parts.length - 1] === "..") {
        parts.push("..");
      } else {
        parts.pop();
      }
      continue;
    }
    parts.push(part);
  }
  return parts.join("/");
}

/** A local:// URI is a workspace-relative path with forward slashes. */
export function localUri(relativePath: string): string {
  if (isAbsolutePath(relativePath)) {
    throw new Error(`Not a workspace-relative path: ${relativePath}`);
  }
  const normalized = normalizePortable(relativePath);
  if (normalized.startsWith("../") || normalized === "..") {
    throw new Error(`Not a workspace-relative path: ${relativePath}`);
  }
  return `local://${normalized}`;
}

/** Parse a local:// URI back into a workspace-relative path with forward slashes. */
export function parseLocalUri(uri: string): string {
  if (!uri.startsWith("local://")) {
    throw new Error(`Not a local:// URI: ${uri}`);
  }
  const rel = uri.slice("local://".length);
  if (
    rel.length === 0 ||
    isAbsolutePath(rel) ||
    rel.split("/").some((part) => part === "..") ||
    rel.includes("\\")
  ) {
    throw new Error(`Unsafe local:// URI: ${uri}`);
  }
  return rel;
}

/** Sanitize untrusted text into a safe filename fragment. Never use LLM text
 * as a raw path component; derive filenames only through this function. */
export function safeFilenameFragment(text: string, fallback = "item"): string {
  const cleaned = text
    .normalize("NFC")
    // eslint-disable-next-line no-control-regex
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^\.+/, "")
    .trim();
  const limited = cleaned.slice(0, 80);
  return limited.length > 0 ? limited : fallback;
}

/** Normalize text to UTF-8 with LF line endings. */
export function normalizeTextLf(text: string): string {
  return text.replace(/\r\n?/g, "\n");
}
