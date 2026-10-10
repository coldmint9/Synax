import { useLocale } from "../../../shared/hooks/useLocale";
import { toolCallPresentation } from "../toolCallPresentation";

interface Props {
  toolId: string;
  summary: string;
  running?: boolean;
}

export function AgentToolRow({ toolId, summary, running }: Props) {
  const { locale } = useLocale();
  const presentation = toolCallPresentation({ toolId, inputSummary: "", category: "" }, locale);
  return (
    <div className="flex items-baseline gap-2.5 py-0.5 text-xs leading-snug">
      <span
        title={presentation.name}
        className={`min-w-0 max-w-[50%] truncate text-[11px] ${running ? "text-primary" : "text-muted-foreground/55"}`}
      >
        {presentation.name}
      </span>
      <span
        className={`min-w-0 flex-1 truncate ${running ? "text-foreground/75" : "text-muted-foreground/55"}`}
      >
        {summary}
      </span>
    </div>
  );
}
