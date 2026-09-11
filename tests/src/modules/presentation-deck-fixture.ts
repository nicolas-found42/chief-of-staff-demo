import JSZip from "jszip";

/**
 * A minimal OOXML presentation package for tests (issue #248).
 *
 * Deck order is the order the slides are listed in `presentation.xml` and its
 * relationship part — deliberately separate from file-name order, so a test
 * can prove the extractor numbers slides by deck, not by part name. A
 * paragraph string may contain `\n`: each line becomes its own run with an
 * explicit `<a:br/>` between them, the way PowerPoint writes a soft break.
 */

const SLIDE_NS =
  'xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" ' +
  'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"';

function slideXml(paragraphs: string[]): string {
  const body = paragraphs
    .map(
      (paragraph) =>
        `<a:p>${paragraph
          .split("\n")
          .map((line) => `<a:r><a:t>${line}</a:t></a:r>`)
          .join("<a:br/>")}</a:p>`,
    )
    .join("");
  return `<?xml version="1.0"?><p:sld ${SLIDE_NS}><p:cSld><p:spTree><p:sp><p:txBody>${body}</p:txBody></p:sp></p:spTree></p:cSld></p:sld>`;
}

export async function deckBytes(
  slides: { part: string; paragraphs: string[] }[],
  options: { relationships?: boolean } = {},
): Promise<Buffer> {
  const zip = new JSZip();
  zip.file(
    "[Content_Types].xml",
    '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
      '<Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml" />' +
      "</Types>",
  );
  zip.file(
    "ppt/presentation.xml",
    '<?xml version="1.0"?><p:presentation ' +
      'xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" ' +
      'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
      `<p:sldIdLst>${slides
        .map((_, index) => `<p:sldId id="${String(256 + index)}" r:id="rId${String(index + 1)}"/>`)
        .join("")}</p:sldIdLst></p:presentation>`,
  );
  if (options.relationships !== false)
    zip.file(
      "ppt/_rels/presentation.xml.rels",
      '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        slides
          .map(
            (slide, index) =>
              `<Relationship Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/${slide.part}.xml" Id="rId${String(index + 1)}"/>`,
          )
          .join("") +
        "</Relationships>",
    );
  for (const slide of slides) zip.file(`ppt/slides/${slide.part}.xml`, slideXml(slide.paragraphs));
  return zip.generateAsync({ type: "nodebuffer" });
}
