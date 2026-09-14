import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, test } from "vitest";
import { EvidenceDate } from "../../../apps/web/src/pages/EvidenceDate";

test.each(["2026-02-31", "2025-02-29", "2026-04-31"])(
  "retains invalid calendar date %s without normalizing provenance",
  (value) => {
    expect(renderToStaticMarkup(createElement(EvidenceDate, { value }))).toBe(
      `<time dateTime="${value}" title="${value}">${value}</time>`,
    );
  },
);
test.each([
  ["2024-02-29", "Feb 29, 2024"],
  ["2026-02-28", "Feb 28, 2026"],
])("formats valid calendar date %s", (value, label) => {
  expect(renderToStaticMarkup(createElement(EvidenceDate, { value }))).toContain(label);
});
