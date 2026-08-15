import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const SCANNER = fileURLToPath(new URL("../../../scripts/scan-banned-token.mjs", import.meta.url));

// Fake tokens are assembled at runtime so their full literals never appear in
// this repository: the scanner must not match its own test file.
const CLEAN_TOKEN = ["fauxbrand", "token", "absent"].join("-");
const PLANTED_TOKEN = ["fauxbrand", "planted"].join("");

function runScanner(extraArgs: string[], env: Record<string, string>) {
  return execFileSync(process.execPath, [SCANNER, ...extraArgs], {
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
}

describe("banned-token scanner", () => {
  it("fails when BANNED_VENDOR_TOKEN is missing", () => {
    expect(() => runScanner([], { BANNED_VENDOR_TOKEN: "" })).toThrow(/missing or empty/);
  });

  it("passes when the token does not appear in tracked files", () => {
    const output = runScanner([], { BANNED_VENDOR_TOKEN: CLEAN_TOKEN });
    expect(output).toContain("zero matches");
  });

  it("detects the token case-insensitively in extra directories", () => {
    const dir = mkdtempSync(join(tmpdir(), "banned-"));
    writeFileSync(join(dir, "sneaky.txt"), "totally fine FAUXBRANDPLANTED mention here\n", "utf8");
    expect(() => runScanner([dir], { BANNED_VENDOR_TOKEN: PLANTED_TOKEN })).toThrow(
      /occurrence\(s\) of the banned token/
    );
  });

  it("detects the token in filenames", () => {
    const dir = mkdtempSync(join(tmpdir(), "banned-"));
    writeFileSync(join(dir, `${PLANTED_TOKEN}-notes.md`), "clean content\n", "utf8");
    expect(() => runScanner([dir], { BANNED_VENDOR_TOKEN: PLANTED_TOKEN })).toThrow(
      /filename contains the banned token/
    );
  });
});
