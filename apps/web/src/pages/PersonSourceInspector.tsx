import { useEffect, useRef, useState } from "react";
import type { PersonSourceDocument } from "@chief-of-staff-demo/shared";
import { errorMessage } from "../client";
import type { DossierClient } from "./PersonDossierPanel";
import "./personSourceInspector.css";
import { EvidenceDate } from "./EvidenceDate";

/** Keeps the evidence beside the reading task, with request lifetime tied to this selection. */
export function PersonSourceInspector({
  profileId,
  sourceId,
  quote,
  client,
  onClose,
  onDetached,
}: {
  profileId: string;
  sourceId: string;
  quote: string;
  client: DossierClient;
  onClose: () => void;
  onDetached: () => Promise<void>;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const live = useRef(false);
  const [document, setDocument] = useState<PersonSourceDocument | null>(null);
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  const [detaching, setDetaching] = useState(false);
  const detachingRef = useRef(false);
  const [detachError, setDetachError] = useState("");

  useEffect(() => {
    live.current = true;
    const element = dialog.current!;
    const opener = window.document.activeElement;
    const fallback = opener
      ?.closest('[aria-label="Person dossier"]')
      ?.querySelector<HTMLElement>('[role="tabpanel"]');
    const page = window.document.documentElement;
    const overflow = page.style.overflow;
    page.style.overflow = "hidden";
    element.showModal();
    // React removes the dialog before passive cleanup, so native restoration alone
    // can lose the citation. Keep its identity without moving the reading position.
    return () => {
      live.current = false;
      element.close();
      page.style.overflow = overflow;
      if (opener instanceof HTMLElement && opener.isConnected)
        opener.focus({ preventScroll: true });
      else if (fallback?.isConnected) fallback.focus({ preventScroll: true });
    };
  }, []);

  useEffect(() => {
    let current = true;
    setError("");
    void client.source(profileId, sourceId).then(
      (value) => {
        if (current) setDocument(value);
      },
      (reason) => {
        if (current) setError(errorMessage(reason));
      },
    );
    return () => {
      current = false;
    };
  }, [client, profileId, sourceId, attempt]);

  const isOpen = () => live.current;
  async function detach() {
    if (detachingRef.current) return;
    detachingRef.current = true;
    setDetaching(true);
    setDetachError("");
    try {
      await client.detach(profileId, sourceId);
      if (!isOpen()) return;
      await onDetached();
      if (isOpen()) onClose();
    } catch (reason) {
      if (live.current) setDetachError(errorMessage(reason));
    } finally {
      detachingRef.current = false;
      if (live.current) setDetaching(false);
    }
  }

  return (
    <dialog
      ref={dialog}
      className="person-source-inspector"
      aria-labelledby="source-inspector-heading"
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
    >
      <header className="source-inspector-header">
        <h2 id="source-inspector-heading">Source evidence</h2>
        <button type="button" onClick={onClose}>
          Close source
        </button>
      </header>
      {error ? (
        <div className="banner-error" role="alert">
          <p>Source could not be loaded. {error}</p>
          <button type="button" onClick={() => setAttempt((value) => value + 1)}>
            Retry source
          </button>
        </div>
      ) : !document ? (
        <p role="status">Loading retained source…</p>
      ) : null}
      {document && (
        <section aria-label="Retained source">
          <div className="source-inspector-identity">
            <p className="source-inspector-eyebrow">Retained evidence · {document.family}</p>
            <h3>{document.title || "Untitled retained source"}</h3>
            <p className="muted">
              {document.author ?? "Author unknown"} · Published{" "}
              <EvidenceDate value={document.publishedAt} />
            </p>
            <p className="source-inspector-url">
              {/^(https?):\/\//i.test(document.url) ? (
                <a href={document.url} target="_blank" rel="noopener noreferrer">
                  {document.url}
                </a>
              ) : (
                document.url
              )}
            </p>
          </div>
          {document.completeness === "partial" && (
            <p role="note" className="source-inspector-passage">
              Partial source:{" "}
              {document.provenanceNote ??
                "Some source content was not retrieved. Missing information remains unknown."}
            </p>
          )}
          {quote && (
            <section className="source-inspector-passage" aria-label="Supporting passage">
              <h4>Supporting passage</h4>
              <p className="muted">The passage cited by the selected dossier statement.</p>
              <blockquote>{quote}</blockquote>
            </section>
          )}
          <details className="source-inspector-provenance">
            <summary>
              Source details · Retrieved <EvidenceDate value={document.retrievedAt} />
            </summary>
            <p className="muted">
              Retrieval records collection, not verification of a claim or identity.
            </p>
            <dl>
              <dt>Retrieved (exact)</dt>
              <dd>{document.retrievedAt}</dd>
              <dt>Published (recorded)</dt>
              <dd>{document.publishedAt ?? "Date unknown"}</dd>
              <dt>Source class</dt>
              <dd>{document.sourceClass}</dd>
              <dt>Retained content</dt>
              <dd>{document.completeness}</dd>
              <dt>Access</dt>
              <dd>{document.access}</dd>
              <dt>Extraction coverage</dt>
              <dd>{document.extractionCoverage ?? "Not recorded"}</dd>
              <dt>Source family</dt>
              <dd>{document.family}</dd>
              <dt>Acquisition</dt>
              <dd>{document.acquisition}</dd>
              <dt>Visibility</dt>
              <dd>{document.visibility}</dd>
            </dl>
          </details>
          <details open>
            <summary>Retained text</summary>
            <div className="source-inspector-text">
              {quote
                ? document.text.split(quote).map((part, index) => (
                    <span key={index}>
                      {index > 0 && <mark>{quote}</mark>}
                      {part}
                    </span>
                  ))
                : document.text}
            </div>
          </details>
          <details className="source-inspector-correction">
            <summary>This source is about someone else</summary>
            <p>
              Remove this source and identical copies from this Profile’s current attribution and
              exclude them from later research. Earlier dossier revisions keep their recorded
              claims; their citations do not grant current source access. The retained source is not
              deleted from other Profiles.
            </p>
            <button type="button" disabled={detaching} onClick={() => void detach()}>
              {detaching ? "Removing attribution…" : "Remove wrong-person attribution"}
            </button>
            {detachError && <p role="alert">{detachError}</p>}
          </details>
        </section>
      )}
    </dialog>
  );
}
