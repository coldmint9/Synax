import { useMemo } from "react";
import "./searchHighlight.css";

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Keywords the server matched, falling back to the raw query so a still-loading
 * search highlights the same text the user typed.
 */
export function highlightTerms(query = "", terms?: readonly string[]): string[] {
  const source = terms?.length ? terms : query.split(/\s+/u);
  return [
    ...new Set(
      source.map((term) => term.trim()).filter((term) => term.length > 0),
    ),
  ].sort((left, right) => right.length - left.length);
}

/** Render matches as text nodes, so queries and message HTML remain inert. */
export function SearchHighlight({
  text,
  query = "",
  terms,
}: {
  text: string;
  query?: string;
  terms?: readonly string[];
}) {
  const words = useMemo(() => highlightTerms(query, terms), [query, terms]);
  if (!words.length) return <>{text}</>;
  const pattern = new RegExp(
    `(${words.map(escapeRegExp).join("|")})`,
    "giu",
  );
  return (
    <>
      {text.split(pattern).map((part, index) =>
        index % 2 ? (
          <mark className="session-search-highlight" key={index}>
            {part}
          </mark>
        ) : (
          part
        ),
      )}
    </>
  );
}
