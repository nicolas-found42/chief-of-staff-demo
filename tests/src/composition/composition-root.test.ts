import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

/**
 * The composition root's own wiring — the gap behind three separate defects.
 *
 * The Transcript Catalog (#125) passed a full suite while production
 * constructed it nowhere: every spec built the Catalog itself, so passing was
 * compatible with the app never touching it, and the miss was found only when
 * #142 came to hand the intake forward. #144 was the same shape one level down —
 * the runs directory and the V1 watchlist were created on the boot path but not
 * by the in-process cutover the gate performs, so a Workspace migrated without a
 * restart came up missing both.
 *
 * Neither is reachable from a unit test the ordinary way. `main.ts` is a
 * top-level-await script that binds a port, so importing it is starting the
 * server; there is no `composeShell()` to call and assert against. What can be
 * done without that refactor is to read it: walk the import graph from `main.ts`
 * and ask which classes production actually constructs. That is a source-level
 * check and it is worth naming as one — it proves a constructor call exists, not
 * that the object it builds is reachable, correct, or ever used. Run against
 * f86f4ef — #125 as it shipped — it fails, naming `TranscriptCatalogStore`,
 * which is more than that commit's own green suite could do.
 *
 * The cheap version of this test — assert `main.ts` mentions a list of names —
 * is worth nothing: the list is another hand-written fixture, and it drifts the
 * way `CONFIG_KEYS` drifted. So the expected set is derived from the source
 * tree, and a new Workspace store joins it by existing.
 */

const SERVER_SRC = fileURLToPath(new URL("../../../apps/server/src", import.meta.url));
const REPO_ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const COMPOSITION_ROOT = join(SERVER_SRC, "main.ts");

interface Composition {
  /** Every server source file the entry point reaches through relative imports. */
  files: Set<string>;
  /** Every class name constructed anywhere in that graph. */
  constructed: Set<string>;
}

/** The `.ts` an ESM `./x.js` specifier means, or null for a package import. */
function resolveRelative(fromFile: string, specifier: string): string | null {
  if (!specifier.startsWith(".")) return null;
  const base = resolve(dirname(fromFile), specifier.replace(/\.js$/, ""));
  return [`${base}.ts`, join(base, "index.ts")].find((candidate) => existsSync(candidate)) ?? null;
}

function parse(file: string): ts.SourceFile {
  return ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.ESNext, true);
}

function compositionFrom(entry: string): Composition {
  const files = new Set<string>();
  const constructed = new Set<string>();
  const pending = [resolve(entry)];
  while (pending.length > 0) {
    const file = pending.pop()!;
    if (files.has(file)) continue;
    files.add(file);
    const source = parse(file);
    const visit = (node: ts.Node): void => {
      if (ts.isNewExpression(node) && ts.isIdentifier(node.expression)) {
        constructed.add(node.expression.text);
      }
      if (
        (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
        node.moduleSpecifier &&
        ts.isStringLiteral(node.moduleSpecifier)
      ) {
        const target = resolveRelative(file, node.moduleSpecifier.text);
        if (target) pending.push(target);
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return { files, constructed };
}

function serverSources(dir: string, found: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) serverSources(path, found);
    else if (path.endsWith(".ts")) found.push(path);
  }
  return found;
}

/**
 * Every exported `…Store`: the classes that own a piece of durable Workspace
 * state. A store nobody constructs is state the product cannot read or write,
 * however green its own suite is.
 */
function workspaceStores(): { name: string; file: string }[] {
  const stores: { name: string; file: string }[] = [];
  for (const file of serverSources(SERVER_SRC)) {
    for (const statement of parse(file).statements) {
      if (
        ts.isClassDeclaration(statement) &&
        statement.name?.text.endsWith("Store") &&
        statement.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)
      ) {
        stores.push({ name: statement.name.text, file: relative(REPO_ROOT, file) });
      }
    }
  }
  return stores;
}

describe("the composition root wires the Workspace it claims to host (#125)", () => {
  const production = compositionFrom(COMPOSITION_ROOT);

  it("constructs every Workspace store the server declares", () => {
    const stores = workspaceStores();
    /* Non-vacuous: the graph really was walked, and the stores really were
       found. An empty expectation is how this test would rot into a no-op. */
    expect(production.files.size).toBeGreaterThan(100);
    expect(stores.length).toBeGreaterThan(5);

    const unwired = stores.filter((store) => !production.constructed.has(store.name));
    expect(
      unwired,
      "a Workspace store no production code constructs is state the product never reads — compose it in main.ts, or delete it",
    ).toEqual([]);
  });

  it("reports what a given entry point composes, not what the repo contains", () => {
    /* The mutation witness for a source-level check. `api/router.ts` declares
       routes over stores handed to it and constructs none itself, so the same
       analysis run from there must come back empty — otherwise the assertion
       above would pass for any entry point at all, including one that had
       dropped the Catalog. */
    const routes = compositionFrom(join(SERVER_SRC, "api/router.ts"));
    expect(routes.files.size).toBeLessThan(production.files.size);
    expect(workspaceStores().filter((store) => routes.constructed.has(store.name))).toEqual([]);
  });
});

/**
 * `startModules` is the boot sequence, named so the migration gate's in-process
 * cutover can perform exactly it. Anything that starts the Workspace from
 * outside that function is a write the gate cannot withhold and the cutover
 * cannot reproduce — which is both halves of #144 at once: the pre-cutover
 * Workspace is no longer untouched, and a Workspace migrated without a restart
 * differs from one migrated with it.
 */
const STARTUP_WRITERS = new Set([
  "mkdirSync",
  "writeFileSync",
  "appendFileSync",
  "renameSync",
  "rmSync",
  "rmdirSync",
  "copyFileSync",
  "cpSync",
]);

/** Called names in one subtree: fs writers by name, and any `seed…` helper. */
function startupWrites(node: ts.Node, source: ts.SourceFile): string[] {
  const found: string[] = [];
  const visit = (current: ts.Node): void => {
    if (ts.isCallExpression(current) && ts.isIdentifier(current.expression)) {
      const name = current.expression.text;
      if (STARTUP_WRITERS.has(name) || name.startsWith("seed")) {
        const { line } = source.getLineAndCharacterOfPosition(current.getStart(source));
        found.push(`${name}() at main.ts:${line + 1}`);
      }
    }
    ts.forEachChild(current, visit);
  };
  visit(node);
  return found;
}

describe("the boot sequence is startModules and nothing else (#144)", () => {
  const source = parse(COMPOSITION_ROOT);
  const startModules = source.statements.find(
    (statement): statement is ts.FunctionDeclaration =>
      ts.isFunctionDeclaration(statement) && statement.name?.text === "startModules",
  );

  it("writes nothing to the Workspace at the top level", () => {
    const topLevel = source.statements
      .filter((statement) => !ts.isFunctionDeclaration(statement))
      .flatMap((statement) => startupWrites(statement, source));
    expect(
      topLevel,
      "a Workspace write outside startModules runs while the gate holds a pre-cutover Workspace, and does not run again when the gate completes in-process",
    ).toEqual([]);
  });

  it("does those writes inside startModules instead", () => {
    /* Not vacuous by deletion: the rule above is satisfied by a boot that
       writes nothing anywhere, which is also a boot that never seeds. */
    expect(startModules).toBeDefined();
    expect(startupWrites(startModules!, source).length).toBeGreaterThan(0);
  });
});
