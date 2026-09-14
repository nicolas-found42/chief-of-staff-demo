/** Collection counts decoded response bytes (after HTTP decompression), not
 * Content-Length. Text retains the existing five-million UTF-16-unit contract;
 * its 15 MB plus BOM byte ceiling accommodates three-byte BMP UTF-8 characters.
 * A producer-owned chunk may exceed the budget; it is checked before copying
 * or decoding and is never added to retained output (REL-01). */
const SOURCE_LIMIT = 5_000_000;

// Only the reader contract is shared by Node and browser Web Streams typings.
interface SourceBody {
  getReader(): {
    read(): Promise<{ done: boolean; value?: Uint8Array | undefined }>;
    cancel(reason?: unknown): Promise<void>;
    releaseLock(): void;
  };
}

export function sourceBodyLimitError(): Error {
  return Object.assign(new Error("Source response exceeded the collection limit."), {
    code: "ERR_SOURCE_BODY_LIMIT",
  });
}

export async function readSourceBytes(
  body: SourceBody | null,
  limit = SOURCE_LIMIT,
): Promise<Buffer> {
  if (!body) return Buffer.alloc(0);
  const reader = body.getReader();
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return Buffer.concat(chunks, size);
      if (!value) continue;
      if (value.byteLength > limit - size) throw sourceBodyLimitError();
      size += value.byteLength;
      // Copy only admitted bytes: a view can otherwise retain a larger buffer.
      chunks.push(Buffer.from(value));
    }
  } catch (error) {
    await reader.cancel(error).catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
  }
}

export async function readSourceText(body: SourceBody | null): Promise<string> {
  if (!body) return "";
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const chunks: string[] = [];
  let bytes = 0;
  let characters = 0;
  function retain(text: string) {
    if (text.length > SOURCE_LIMIT - characters) throw sourceBodyLimitError();
    characters += text.length;
    chunks.push(text);
  }
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        retain(decoder.decode());
        return chunks.join("");
      }
      if (!value) continue;
      if (value.byteLength > SOURCE_LIMIT * 3 + 3 - bytes) throw sourceBodyLimitError();
      bytes += value.byteLength;
      // Decode in small windows so an admitted large input chunk cannot create
      // an arbitrarily large temporary string before the character check.
      for (let offset = 0; offset < value.byteLength; offset += 16_384)
        retain(decoder.decode(value.subarray(offset, offset + 16_384), { stream: true }));
    }
  } catch (error) {
    await reader.cancel(error).catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
  }
}
