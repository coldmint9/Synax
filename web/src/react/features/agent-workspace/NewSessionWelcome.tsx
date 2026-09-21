import { useLocale } from "../../../hooks/useLocale";
import { SynaxWordmark } from "./SynaxWordmark";

export function NewSessionWelcome() {
  const { t } = useLocale();
  return (
    <header className="session-welcome">
      <SynaxWordmark />
      <h2 className="session-welcome-title">{t("sessionDraftTitle")}</h2>
    </header>
  );
}
