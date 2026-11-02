import { MessageCircle } from "lucide-react";
import { useLocale } from "../../shared/hooks/useLocale";

/**
 * A collapsed side chat stays reachable on the conversation edge. The tab rests
 * in the empty top gutter, clear of the turn rail that owns the middle of that
 * edge, and slides out on hover or keyboard focus.
 */
export function SideChatPill({ onOpen }: { onOpen: () => void }) {
  const { t } = useLocale();
  return (
    <button
      type="button"
      className="side-chat-pill"
      data-side-chat-pill="true"
      aria-label={t("sideChatOpen")}
      title={t("sideChatOpen")}
      onClick={onOpen}
    >
      <MessageCircle size={15} aria-hidden="true" />
      <span className="side-chat-pill-label">{t("sideChatTitle")}</span>
    </button>
  );
}
