import { useEffect, useState } from "react";
import { useLocale } from "../../shared/hooks/useLocale";
// Reuse the draft-scene typewriter instead of a second copy of the same animation.
import { WelcomeTypewriter } from "../agent-workspace/WelcomeTypewriter";
import { WELCOME_TITLE_DELAY } from "../agent-workspace/welcomeTyping";
import { GREETING_PHASE_RULES, greetingPhaseAt } from "./greetingPhase";
import { activeGreetingPlugins, GREETING_PLUGINS, type GreetingPlugin } from "./greetingPlugin";
import "./homeGreeting.css";

/** A minute is short enough to catch a phase change without polling the clock. */
const CLOCK_TICK_MS = 60_000;

const pad = (value: number) => String(value).padStart(2, "0");

interface Props {
  /** Reminder-style surfaces rendered between the greeting and the quick actions. */
  plugins?: readonly GreetingPlugin[];
}

/** Home hero: a typed greeting for the current hour, then a pointer to the shortcuts below. */
export function HomeGreeting({ plugins = GREETING_PLUGINS }: Props) {
  const { locale, t } = useLocale();
  const name: string | null = null;
  const [now, setNow] = useState(() => new Date());

  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), CLOCK_TICK_MS);
    return () => window.clearInterval(timer);
  }, []);

  const phase = greetingPhaseAt(now);
  const rule = GREETING_PHASE_RULES[phase];
  const clock = `${pad(now.getHours())}:${pad(now.getMinutes())}`;
  const context = { locale, name, phase, now };
  const slots = activeGreetingPlugins(plugins, context);

  return (
    <div className="home-greeting" data-phase={phase}>
      <p className="home-greeting__meta">
        <span className="home-greeting__dot" aria-hidden="true" />
        <time dateTime={clock}>{clock}</time>
        <span>{t(rule.label)}</span>
      </p>
      <h1 className="home-greeting__title">
        <WelcomeTypewriter
          text={t(name ? rule.named : rule.anonymous, name ? { name } : undefined)}
          delay={WELCOME_TITLE_DELAY}
        />
      </h1>
      <p className="home-greeting__guide">{t("greetingGuide")}</p>
      {slots.length > 0 && (
        <div className="home-greeting__slots">
          {slots.map((plugin) => (
            <div key={plugin.id} data-greeting-plugin={plugin.id}>
              {plugin.render(context)}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
