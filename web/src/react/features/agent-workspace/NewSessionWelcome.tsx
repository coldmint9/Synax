import { useLocale } from "../../../hooks/useLocale";
import { WelcomeTypewriter } from "./WelcomeTypewriter";
import { WELCOME_TITLE_DELAY } from "./welcomeTyping";
import { SynaxWordmark } from "./SynaxWordmark";

export function NewSessionWelcome({ finish = false }: { finish?: boolean }) {
  const { t } = useLocale();
  return (
    <header className="session-welcome">
      <div data-welcome-layer="mark">
        <SynaxWordmark />
      </div>
      <h2 className="session-welcome-title" data-welcome-layer="title">
        <WelcomeTypewriter
          text={t("sessionDraftTitle")}
          delay={WELCOME_TITLE_DELAY}
          finish={finish}
        />
      </h2>
    </header>
  );
}
