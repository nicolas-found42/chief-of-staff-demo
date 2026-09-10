import { useState, type ReactNode } from "react";

/** Reading choices survive a refresh without altering the underlying artifact. */
export function ReadingDisclosure({
  id,
  label,
  children,
  initialOpen = false,
}: {
  id: string;
  label: string;
  children: ReactNode;
  initialOpen?: boolean;
}) {
  const storageKey = `meeting-reading:${id}`;
  const [open, setOpen] = useState(
    () => initialOpen || sessionStorage.getItem(storageKey) === "open",
  );
  return (
    <details open={open}>
      <summary
        id={`reading-${id}`}
        onClick={(event) => {
          event.preventDefault();
          sessionStorage.setItem(storageKey, !open ? "open" : "closed");
          setOpen(!open);
        }}
      >
        {label}
      </summary>
      {children}
    </details>
  );
}
