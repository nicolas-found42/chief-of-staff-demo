import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { openRuns } from "../../../apps/server/src/runs";

it.each(["writeFileSync", "renameSync", "readFileSync"])(
  "a process killed around %s preserves one complete artifact through two recoveries",
  (boundary) => {
    const workspace = mkdtempSync(join(tmpdir(), "commit-process-"));
    try {
      for (const when of ["before", "after"]) {
        const run = openRuns(workspace).create({
          module: "synthetic",
          moduleVersion: 1,
          intake: "test",
          sourceUrl: null,
          externalId: null,
        });
        run.writeArtifact("result.json", '{"accepted":"original"}');
        const program = `
          import fs from 'node:fs';
          import { syncBuiltinESMExports } from 'node:module';
          const { openRuns } = await import(${JSON.stringify(new URL("../../../apps/server/src/runs.ts", import.meta.url).href)});
          const run = openRuns(${JSON.stringify(workspace)}).open(${JSON.stringify(run.id)});
          const original = fs[${JSON.stringify(boundary)}];
          fs[${JSON.stringify(boundary)}] = function(...args) {
            if (!String(args[0]).includes('result.json')) return original.apply(this,args);
            if (${JSON.stringify(when)} === 'before') process.kill(process.pid,'SIGKILL');
            const result = original.apply(this,args);
            process.kill(process.pid,'SIGKILL');
            return result;
          };
          syncBuiltinESMExports();
          run.writeArtifact('result.json','{"accepted":"replacement"}');
        `;
        const child = spawnSync(process.execPath, [
          "--import",
          "tsx",
          "--input-type=module",
          "-e",
          program,
        ]);
        expect(child.signal).toBe("SIGKILL");
        const expected =
          boundary === "readFileSync" || (boundary === "renameSync" && when === "after")
            ? '{"accepted":"replacement"}'
            : '{"accepted":"original"}';
        for (let recovery = 0; recovery < 2; recovery++) {
          const recovered = openRuns(workspace).open(run.id);
          if (!recovered) throw new Error("Committed Run disappeared after process death");
          expect(recovered.readArtifact("result.json")).toBe(expected);
          recovered.writeArtifact("result.json", expected);
          expect(recovered.readArtifact("result.json")).toBe(expected);
        }
      }
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  },
);
