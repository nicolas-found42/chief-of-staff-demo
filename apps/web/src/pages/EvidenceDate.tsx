/** Date-only evidence keeps its day; instants explicitly display UTC and retain exact provenance. */
export function EvidenceDate({ value }: { value: string | null | undefined }) {
  if (!value) return <>Date unknown</>;
  const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(value);
  const hasZone = /(?:Z|[+-]\d{2}:\d{2})$/i.test(value);
  const parsed = new Date(dateOnly ? `${value}T12:00:00Z` : value);
  const label =
    (dateOnly || hasZone) && Number.isFinite(parsed.getTime())
      ? new Intl.DateTimeFormat("en", {
          year: "numeric",
          month: "short",
          day: "numeric",
          timeZone: "UTC",
          ...(dateOnly ? {} : { hour: "2-digit", minute: "2-digit", timeZoneName: "short" }),
        }).format(parsed)
      : value;
  return (
    <time dateTime={value} title={value}>
      {label}
    </time>
  );
}
