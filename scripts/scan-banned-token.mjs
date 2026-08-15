#!/usr/bin/env node
/**
 * Case-insensitive banned-vendor-token scanner.
 *
 * Reads BANNED_VENDOR_TOKEN from the environment and fails when it is missing
 * or empty. Scans every tracked file's name and content plus any extra
 * directories passed as CLI arguments (used for the production build scan).
 * Exits 1 with a report on any match.
 */
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const token = (process.env.BANNED_VENDOR_TOKEN ?? "").trim();
if (token.length === 0) {
  console.error("BANNED_VENDOR_TOKEN is missing or empty; refusing to scan.");
  process.exit(1);
}
const needle = token.toLowerCase();
let repoRoot;
try {
  repoRoot = execFileSync("git", ["rev-parse", "--show-toplevel"], {
    encoding: "utf8",
  }).trim();
} catch (error) {
  console.error(`Unable to resolve the repository root (git rev-parse failed): ${error.message}`);
  process.exit(1);
}

const files = new Set();

let tracked = [];
try {
  tracked = execFileSync("git", ["-C", repoRoot, "ls-files", "-z"], { encoding: "utf8" })
    .split("\0")
    .filter(Boolean);
} catch (error) {
  console.error(`Unable to list tracked files (git ls-files failed): ${error.message}`);
  process.exit(1);
}
for (const file of tracked) {
  files.add(file);
}
function walk(dir) {
  let entries = [];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = join(dir, entry);
    let stat;
    try {
      stat = statSync(full);
    } catch {
      continue;
    }
    if (stat.isDirectory()) {
      walk(full);
    } else if (stat.isFile()) {
      files.add(relative(process.cwd(), full).split("\\").join("/"));
    }
  }
}

for (const extraDir of process.argv.slice(2)) {
  walk(extraDir);
}

const matches = [];
for (const file of [...files].sort()) {
  const normalizedName = file.toLowerCase();
  if (normalizedName.includes(needle)) {
    matches.push(`${file}: filename contains the banned token`);
    continue;
  }
  let buffer;
  try {
    buffer = readFileSync(join(repoRoot, file));
  } catch {
    continue;
  }
  const haystack = buffer.toString("latin1").toLowerCase();
  let count = 0;
  let index = haystack.indexOf(needle);
  while (index >= 0) {
    count += 1;
    index = haystack.indexOf(needle, index + 1);
  }
  if (count > 0) {
    matches.push(`${file}: ${count} occurrence(s) of the banned token`);
  }
}

if (matches.length > 0) {
  console.error(`Banned-token scan failed: ${matches.length} match(es) in ${files.size} scanned files.`);
  for (const match of matches) {
    console.error(`  - ${match}`);
  }
  process.exit(1);
}
console.log(`Banned-token scan passed: zero matches in ${files.size} files.`);
process.exit(0);
