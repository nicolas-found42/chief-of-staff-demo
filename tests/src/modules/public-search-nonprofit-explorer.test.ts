import { expect, test } from "vitest";
import { createNonprofitExplorerProvider } from "../../../apps/server/src/source-adapters/providers/person-records.js";
import type { PublicHttpFetch } from "../../../apps/server/src/source-adapters/http.js";

const fetchResponse =
  (body: string): PublicHttpFetch =>
  async (url) => ({
    url,
    status: 404,
    contentType: "application/json",
    etag: null,
    lastModified: null,
    retryAfter: null,
    body,
  });
test("Nonprofit Explorer represents a valid zero-result search as empty, not inaccessible", async () => {
  const fetch = fetchResponse(
    JSON.stringify({
      api_version: 2,
      total_results: 0,
      organizations: [],
      num_pages: 0,
      search_query: "Richard Achee",
    }),
  );
  await expect(
    createNonprofitExplorerProvider({ fetch }).search("Richard Achee", { fetch, timeoutMs: 1000 }),
  ).resolves.toEqual([]);
});
test("Nonprofit Explorer does not hide an actual missing route or malformed response", async () => {
  for (const body of [
    "<html>Not found</html>",
    JSON.stringify({ organizations: [] }),
    JSON.stringify({ api_version: 2, total_results: 1, organizations: [] }),
  ]) {
    const fetch = fetchResponse(body);
    await expect(
      createNonprofitExplorerProvider({ fetch }).search("Richard Achee", {
        fetch,
        timeoutMs: 1000,
      }),
    ).rejects.toThrow("404");
  }
});
