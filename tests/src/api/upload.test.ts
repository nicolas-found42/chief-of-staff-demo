import multipart from "@fastify/multipart";
import fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { registerApi, type ApiContext } from "../../../apps/server/src/api/router";
import type { Pipeline } from "../../../apps/server/src/pipeline/run";
import { MAX_UPLOAD_BYTES } from "../../../apps/server/src/text/convert";

const BOUNDARY = "----uploadtest";

/** A multipart body with one file part per entry, in order. */
function multipartBody(parts: { field: string; fileName: string; content: string }[]): string {
  return (
    parts
      .map(
        ({ field, fileName, content }) =>
          `--${BOUNDARY}\r\n` +
          `content-disposition: form-data; name="${field}"; filename="${fileName}"\r\n` +
          `content-type: text/markdown\r\n\r\n${content}\r\n`
      )
      .join("") + `--${BOUNDARY}--\r\n`
  );
}

let app: FastifyInstance;
let started: { fileName: string; bytes: Buffer }[];

beforeEach(async () => {
  started = [];
  app = fastify({ logger: false });
  await app.register(multipart, { limits: { fileSize: MAX_UPLOAD_BYTES, files: 50 } });
  const pipeline = {
    startRun: async ({ fileName, bytes }: { fileName: string; bytes: Buffer }) => {
      started.push({ fileName, bytes });
      return `run_20260819-000000_0000000${started.length}`;
    },
  } as unknown as Pipeline;
  await registerApi(app, { workspaceDir: ".", port: 4317, pipeline } as unknown as ApiContext);
  await app.ready();
});

afterEach(async () => {
  await app.close();
});

function upload(body: string) {
  return app.inject({
    method: "POST",
    url: "/api/runs/upload",
    headers: { "content-type": `multipart/form-data; boundary=${BOUNDARY}` },
    payload: body,
  });
}

describe("POST /api/runs/upload", () => {
  it("accepts files posted under the 'files' field", async () => {
    const response = await upload(
      multipartBody([{ field: "files", fileName: "a.md", content: "# transcript" }])
    );
    expect(response.statusCode).toBe(202);
    expect(response.json()).toEqual({ runIds: ["run_20260819-000000_00000001"] });
    expect(started).toHaveLength(1);
    expect(started[0].fileName).toBe("a.md");
  });

  it("answers 400 instead of hanging when the field name is wrong", async () => {
    const response = await upload(
      multipartBody([{ field: "file", fileName: "a.md", content: "# transcript" }])
    );
    expect(response.statusCode).toBe(400);
    expect(response.json().error).toContain("multipart field name must be 'files'");
    expect(started).toHaveLength(0);
  });

  it("processes the correct field even when a wrongly named part precedes it", async () => {
    const response = await upload(
      multipartBody([
        { field: "file", fileName: "ignored.md", content: "x".repeat(4096) },
        { field: "files", fileName: "b.md", content: "# transcript" },
      ])
    );
    expect(response.statusCode).toBe(202);
    expect(started.map((run) => run.fileName)).toEqual(["b.md"]);
  });

  it("rejects an unsupported extension without starting a run", async () => {
    const response = await upload(
      multipartBody([{ field: "files", fileName: "notes.rtf", content: "x" }])
    );
    expect(response.statusCode).toBe(400);
    expect(response.json().error).toContain("unsupported file type");
    expect(started).toHaveLength(0);
  });
});
