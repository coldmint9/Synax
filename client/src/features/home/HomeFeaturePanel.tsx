import { InfoTooltip } from "@/shared/ui/ui/InfoTooltip";
import { Tooltip } from "@/shared/ui/ui/Tooltip";
import {
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type PointerEvent,
  type ReactNode,
} from "react";
import { Link } from "react-router-dom";
import { ArrowRight, ArrowUpRight, ChevronDown, LoaderCircle, PenLine, Sparkles } from "lucide-react";
import {
  QUICK_ACTIONS,
  QUICK_ACTION_CATEGORIES,
  buildQuickActionLaunch,
  pinnedQuickActions,
  quickActionAttachment,
  quickActionSkills,
  visibleQuickActions,
  type Locale,
  type QuickAction,
  type QuickActionAttachment,
  type QuickActionCategory,
  type QuickActionLaunch,
} from "../quick-actions/quickActions";
import "./homeFeatures.css";

interface Props {
  children?: ReactNode;
  locale: Locale;
  actions?: readonly QuickAction[];
  /** Starts a session from the action's skill stack. */
  onLaunch?: (launch: QuickActionLaunch) => void;
  /** Attaches a procedure that needs user input instead of sending it. */
  onAttach?: (attachment: QuickActionAttachment) => void;
  launchDisabled?: boolean;
  /** Action currently creating its session, so the card can show progress. */
  launchingId?: string | null;
}

function spotlight(event: PointerEvent<HTMLElement>) {
  const rect = event.currentTarget.getBoundingClientRect();
  event.currentTarget.style.setProperty("--qa-spot-x", `${event.clientX - rect.left}px`);
  event.currentTarget.style.setProperty("--qa-spot-y", `${event.clientY - rect.top}px`);
}

/**
 * Shared by the global home and the Work draft; a click starts the session, it never only fills text.
 * The pinned shortcuts stay docked on the composer and the whole catalog opens above them on demand.
 */
export function HomeFeaturePanel({
  children, locale, actions = QUICK_ACTIONS, onLaunch, onAttach, launchDisabled = false, launchingId = null,
}: Props) {
  const zh = locale === "zh";
  const catalogId = useId();
  const [expanded, setExpanded] = useState(false);
  const [category, setCategory] = useState<QuickActionCategory | "all">("all");
  const tabsRef = useRef<HTMLDivElement>(null);
  const catalogRef = useRef<HTMLDivElement>(null);
  const [indicator, setIndicator] = useState({ left: 0, width: 0 });
  const signedIn = false;
  const pinned = pinnedQuickActions(actions, { signedIn });
  const visible = visibleQuickActions(actions, { signedIn, category });
  const launching = actions.find((action) => action.id === launchingId);

  // Keep the active segment pill attached to the real label width, including
  // locale changes, container resizes and the catalog being opened.
  useLayoutEffect(() => {
    const group = tabsRef.current;
    if (!group) return;
    const measure = () => {
      const active = group.querySelector<HTMLElement>('[aria-pressed="true"]');
      if (active) setIndicator({ left: active.offsetLeft, width: active.offsetWidth });
    };
    measure();
    if (catalogRef.current) catalogRef.current.scrollTop = 0;
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(group);
    return () => observer.disconnect();
  }, [category, locale, expanded]);

  // Arrow keys move through the grid like a desktop launcher.
  const handleGridKeyDown = (event: KeyboardEvent<HTMLUListElement>) => {
    const keyDelta = { ArrowRight: 1, ArrowLeft: -1, ArrowDown: "row", ArrowUp: "-row" } as const;
    const step = keyDelta[event.key as keyof typeof keyDelta];
    if (!step) return;
    const cards = [...event.currentTarget.querySelectorAll<HTMLElement>(".home-feature:not(:disabled)")];
    const index = cards.indexOf(document.activeElement as HTMLElement);
    if (index < 0) return;
    const columns = (getComputedStyle(event.currentTarget).gridTemplateColumns || "").split(" ").filter(Boolean).length || 1;
    const delta = step === "row" ? columns : step === "-row" ? -columns : step;
    const next = cards[index + delta];
    if (!next) return;
    event.preventDefault();
    next.focus();
  };

  /** One card, rendered dense in the dock and full-size in the catalog. */
  const renderCard = (action: QuickAction, index: number, compact: boolean) => {
    const Icon = action.icon;
    const skills = quickActionSkills(action, signedIn);
    const description = action.description[locale];
    const skillNames = skills.map((item) => item.label[locale]);
    const requiresInput = action.kind === "launch" && action.policy === "compose";
    const inputHint = requiresInput && action.kind === "launch" ? action.input?.hint[locale] : undefined;
    const hint = [
      description,
      inputHint ? `${zh ? "需补充" : "Needs"} · ${inputHint}` : "",
      skills.length ? `${zh ? "技能" : "Skills"} · ${skillNames.join(" + ")}` : "",
    ].filter(Boolean).join("\n\n");
    const isLaunching = action.id === launchingId;
    const canPick = requiresInput ? Boolean(onAttach) : Boolean(onLaunch);
    const trailing = isLaunching
      ? <LoaderCircle className="home-feature__spinner" size={14} aria-hidden="true" />
      : compact
        ? null
        : action.kind === "navigate"
          ? <ArrowUpRight size={14} aria-hidden="true" />
          : requiresInput
            ? <PenLine size={13} aria-hidden="true" />
            : <ArrowRight size={14} aria-hidden="true" />;
    const content = <>
      <span className="home-feature__icon"><Icon size={18} aria-hidden="true" /></span>
      <span className="home-feature__copy"><strong>{action.title[locale]}</strong></span>
      {skills.length > 0 && (
        <span className="home-feature__stack" aria-hidden="true">
          <Sparkles size={11} />
          {skills.length}
        </span>
      )}
      {trailing}
    </>;
    const label = `${action.title[locale]}. ${hint}`;
    const shared = {
      className: "home-feature",
      "aria-label": label,
      "data-category": action.category,
      "data-compact": compact ? "true" : undefined,
      "data-launching": isLaunching ? "true" : undefined,
      onPointerMove: spotlight,
    } as const;
    return <li key={action.id} data-featured={!compact && action.featured ? "true" : undefined}
      style={{ "--qa-index": index } as CSSProperties}>
      <Tooltip content={<span className="home-feature__tip">
        <span className="home-feature__tip-title">{action.title[locale]}</span>
        <span className="home-feature__tip-description">{description}</span>
        {inputHint && <span className="home-feature__tip-input">{zh ? "需补充" : "Needs"} · {inputHint}</span>}
        {skills.length > 0 && <span className="home-feature__tip-skills">
          {skills.map((item) => (
            <span key={item.id} className="home-feature__tip-skill">{item.label[locale]}</span>
          ))}
        </span>}
      </span>}>
        {action.kind === "navigate"
          ? <Link {...shared} to={action.to}>{content}</Link>
          : <button type="button" {...shared}
              aria-busy={isLaunching || undefined}
              disabled={!canPick || launchDisabled}
              onClick={() => {
                const launch = buildQuickActionLaunch(action, { locale, signedIn });
                if (!launch) return;
                if (requiresInput) {
                  const attachment = quickActionAttachment(action, launch, locale);
                  if (attachment) onAttach?.(attachment);
                  return;
                }
                onLaunch?.(launch);
              }}>{content}</button>}
      </Tooltip>
    </li>;
  };

  return (
    <section
      className="home-feature-panel"
      aria-label={zh ? "快捷操作" : "Quick actions"}
      data-expanded={expanded ? "true" : "false"}
    >
      {children && <div className="home-feature-panel__welcome">{children}</div>}
      {expanded && (
        <div className="home-feature-panel__full">
          <div className="home-feature-panel__toolbar">
            <div className="home-feature-panel__heading">
              <h2>{zh ? "快捷操作" : "Quick actions"}</h2>
              <InfoTooltip label={zh ? "快捷操作说明" : "About quick actions"}>
                {zh
                  ? "点击即按对应技能组开始新会话；输入框里已有的内容会作为补充上下文并入任务说明。"
                  : "Each shortcut starts a session with its skill stack. Text already in the composer is added as context."}
              </InfoTooltip>
            </div>
            <div
              ref={tabsRef}
              className="home-feature-panel__categories"
              role="group"
              aria-label={zh ? "功能分类" : "Feature category"}
              style={{ "--qa-indicator-left": `${indicator.left}px`, "--qa-indicator-width": `${indicator.width}px` } as CSSProperties}
            >
              <span className="home-feature-panel__category-indicator" aria-hidden="true" />
              {QUICK_ACTION_CATEGORIES.map((item) => (
                <button key={item.id} type="button" aria-pressed={category === item.id} onClick={() => setCategory(item.id)}>
                  {item.label[locale]}
                </button>
              ))}
            </div>
          </div>
          <div ref={catalogRef} id={catalogId} className="home-feature-panel__catalog" tabIndex={0}
            aria-label={zh ? "预制功能列表" : "Preset features"}>
            {visible.length ? <ul key={category} className="home-feature-panel__grid" onKeyDown={handleGridKeyDown}>
              {visible.map((action, index) => renderCard(action, index, false))}
            </ul> : <p className="home-feature-panel__empty" role="status">{zh ? "该分类暂无功能" : "No features in this category"}</p>}
          </div>
        </div>
      )}
      <div className="home-feature-dock">
        <ul className="home-feature-dock__row" aria-label={zh ? "主推功能" : "Featured shortcuts"}>
          {pinned.map((action, index) => renderCard(action, index, true))}
        </ul>
        <button
          type="button"
          className="home-feature-dock__toggle"
          aria-expanded={expanded}
          aria-controls={expanded ? catalogId : undefined}
          onClick={() => setExpanded((open) => !open)}
        >
          {expanded ? (zh ? "收起" : "Less") : (zh ? "更多" : "More")}
          <ChevronDown className="home-feature-dock__chevron" size={13} aria-hidden="true" />
        </button>
      </div>
      <p className="home-feature-panel__status" role="status" aria-live="polite">
        {launching ? `${zh ? "正在启动" : "Starting"} ${launching.title[locale]}` : ""}
      </p>
      {!onLaunch && <p className="home-feature-panel__hint">
        {zh ? "选择工作区后可使用开发助手。" : "Select a workspace to use development actions."}
      </p>}
    </section>
  );
}
