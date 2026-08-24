import { describe, expect, it } from "vitest";
import {
  SourceError,
  convertToText,
  normalizeTextLf,
  sentencesToText,
} from "../../../apps/server/src/text/convert";

describe("sentencesToText", () => {
  it("renders speaker lines in index order regardless of array order", () => {
    const input = [
      { index: 2, speaker_name: "Priya", text: "second", start_time: 40 },
      { index: 0, speaker_name: "Dana", text: "first", start_time: 0 },
      { index: 1, speaker_name: "Sam", text: "middle", start_time: 20 },
    ];
    expect(sentencesToText(input)).toBe("Dana: first\nSam: middle\nPriya: second");
  });

  it("falls back to start_time ordering when index is absent", () => {
    const input = [
      { speaker_name: "B", text: "later", start_time: 9_000 },
      { speaker_name: "A", text: "earlier", start_time: 1_000 },
    ];
    expect(sentencesToText(input)).toBe("A: earlier\nB: later");
  });

  it("accepts startTime as the alias for start_time", () => {
    const input = [{ speaker_name: "A", text: "hi", startTime: 5 }];
    expect(sentencesToText(input)).toBe("A: hi");
  });

  it("accepts sentence as the alias for text", () => {
    const input = [{ speaker_name: "A", sentence: "hello", start_time: 1 }];
    expect(sentencesToText(input)).toBe("A: hello");
  });

  it("throws SOURCE_INVALID for a non-Fireflies JSON object", () => {
    expect(() => sentencesToText({ foo: "bar" })).toThrowError(SourceError);
    try {
      sentencesToText({ foo: "bar" });
    } catch (error) {
      expect((error as SourceError).code).toBe("SOURCE_INVALID");
    }
  });

  it("throws SOURCE_INVALID for an array of non-sentence entries", () => {
    expect(() => sentencesToText([1, 2, 3])).toThrowError(SourceError);
    expect(() => sentencesToText([{ text: "no speaker" }])).toThrowError(SourceError);
  });
});

describe("convertToText", () => {
  it("decodes .txt/.md as UTF-8 with normalized LF endings", async () => {
    const bytes = Buffer.from("line one\r\nline two\rline three\n", "utf8");
    expect(await convertToText("notes.md", bytes)).toBe("line one\nline two\nline three\n");
  });

  it("round-trips a Fireflies sentences JSON export", async () => {
    const sentences = [
      { index: 1, speaker_name: "Dana", text: "hello", start_time: 1 },
      { index: 0, speaker_name: "Sam", text: "hi", start_time: 0 },
    ];
    const text = await convertToText("fireflies.json", Buffer.from(JSON.stringify(sentences)));
    expect(text).toBe("Sam: hi\nDana: hello");
  });

  it("throws SOURCE_INVALID for JSON that is not a sentences array", async () => {
    await expect(
      convertToText("data.json", Buffer.from('{"kind": "report"}')),
    ).rejects.toThrowError(SourceError);
  });

  it("throws SOURCE_UNSUPPORTED for a gated extension", async () => {
    await expect(convertToText("sheet.xlsx", Buffer.from("x"))).rejects.toThrowError(SourceError);
  });
});

describe("normalizeTextLf", () => {
  it("normalizes CR and CRLF to LF", () => {
    expect(normalizeTextLf("a\r\nb\rc\nd")).toBe("a\nb\nc\nd");
  });
});
