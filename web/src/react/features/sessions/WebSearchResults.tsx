import { z } from "zod";

const outputSchema = z.object({
  type: z.literal("web_search_results"),
  provider: z.string(),
  results: z.array(
    z.object({
      referenceId: z.string(),
      title: z.string(),
      url: z
        .string()
        .url()
        .refine((value) => {
          try {
            const url = new URL(value);
            return (
              ["http:", "https:"].includes(url.protocol) &&
              !url.username &&
              !url.password
            );
          } catch {
            return false;
          }
        }),
      snippet: z.string(),
    }),
  ),
});

export function webSearchQuery(inputSummary: string): string {
  try {
    const input = JSON.parse(inputSummary);
    return typeof input?.query === "string" ? input.query : inputSummary;
  } catch {
    return inputSummary;
  }
}

export function WebSearchResults({ output }: { output: unknown }) {
  const parsed = outputSchema.safeParse(output);
  if (!parsed.success) return null;
  const { results, provider } = parsed.data;
  return (
    <section aria-label="联网搜索结果" className="mt-2 space-y-2 text-[11px]">
      <p className="text-muted-foreground">{provider} · 搜索摘要，非网页全文</p>
      {results.length === 0 ? (
        <p className="text-muted-foreground">未找到符合条件的搜索结果。</p>
      ) : (
        <ol className="space-y-2">
          {results.map((result, index) => (
            <li
              key={result.referenceId}
              className="rounded border border-border/40 px-2.5 py-2"
            >
              <a
                href={result.url}
                target="_blank"
                rel="noopener noreferrer"
                className="break-words font-medium text-foreground underline decoration-primary/60 underline-offset-2 hover:decoration-current"
              >
                {index + 1}. {result.title}
              </a>
              <p className="mt-0.5 break-all text-[10px] text-muted-foreground">
                {result.url}
              </p>
              {result.snippet && (
                <p className="mt-1 whitespace-pre-wrap break-words leading-relaxed text-foreground/80">
                  {result.snippet}
                </p>
              )}
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
