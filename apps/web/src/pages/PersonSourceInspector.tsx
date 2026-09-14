import { useEffect, useRef, useState } from "react";
import type { PersonSourceDocument } from "@chief-of-staff-demo/shared";
import { errorMessage } from "../client";
import type { DossierClient } from "./PersonDossierPanel";
import "./personSourceInspector.css";

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
    element.showModal();
    // React removes the dialog before passive cleanup, so native restoration alone
    // can lose the citation. Keep its identity without moving the reading position.
    return () => {
      live.current = false;
      element.close();
      if (opener instanceof HTMLElement && opener.isConnected)
        opener.focus({ preventScroll: true });
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
          <h3>{document.title}</h3>
          <p className="muted">
            {document.author ?? "Author unknown"} · Published{" "}
            {document.publishedAt ?? "date unknown"} · Retrieved {document.retrievedAt}
          </p>
          <p className="source-inspector-url">{document.url}</p>
          <p className="muted">
            {document.sourceClass} · {document.completeness} · {document.access} · Extraction{" "}
            {document.extractionCoverage ?? "coverage not recorded"} · Source family{" "}
            {document.family}
          </p>
          {quote && (
            <>
              <h4>Supporting passage</h4>
              <blockquote>{quote}</blockquote>
            </>
          )}
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
              Remove its attribution to this Profile when the evidence identifies a different
              person.
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
