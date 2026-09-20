import "./searchHighlight.css";
/** Render matches as text nodes, so queries and message HTML remain inert. */
export function SearchHighlight({
  text,
  query = "",
}: {
  text: string;
  query?: string;
}) {
  if (!query) return <>{text}</>;
  const pattern = new RegExp(
    `(${query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})`,
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
