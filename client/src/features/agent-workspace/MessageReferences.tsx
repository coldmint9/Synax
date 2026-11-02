import { memo } from "react";
import type { TurnReference } from "../../adapters/transport/agentRuntime";
import { useLocale } from "../../shared/hooks/useLocale";
import { turnReferenceIcon, turnReferenceKindLabel } from "./turnReferences";

/**
 * Turn references are attachment-like context the user added to one message.
 * The transcript keeps them out of the message bubble so the text stays the
 * text the user actually typed.
 */
export const MessageReferences = memo(function MessageReferences({
  references,
}: {
  references?: TurnReference[];
}) {
  const { locale } = useLocale();
  const zh = locale === "zh";
  if (!references?.length) return null;
  return (
    <ul
      className="session-reference-tags"
      aria-label={zh ? "本条消息引用" : "References for this message"}
    >
      {references.map((reference) => {
        const Icon = turnReferenceIcon(reference.kind);
        return (
          <li
            key={`${reference.kind}:${reference.id}`}
            className="session-reference-tag"
            data-kind={reference.kind}
            title={reference.id}
          >
            <Icon size={12} aria-hidden="true" />
            <span>
              {turnReferenceKindLabel(reference.kind, zh)} ·{" "}
              {reference.label ?? reference.id}
            </span>
          </li>
        );
      })}
    </ul>
  );
});
