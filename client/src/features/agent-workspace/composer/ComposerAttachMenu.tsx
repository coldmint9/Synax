import { useEffect, useRef, useState } from "react";
import { Check, Plus, Sparkles } from "lucide-react";
import {
  Popover,
  PopoverButton,
  PopoverPanel,
} from "@/shared/ui/ui/Popover";
import { OverlayStateObserver } from "@/shared/ui/ui/OverlayStateObserver";
import { Field, Label } from "@/shared/ui/ui/Field";
import { Checkbox } from "@/shared/ui/ui/Toggle";
import { Tooltip } from "@/shared/ui/ui/Tooltip";
import { skillsApi, type SkillSummary } from "../../../adapters/transport/skills";
import { useLocale } from "../../../shared/hooks/useLocale";
import { quickActionSkills, type QuickAction } from "../../quick-actions/quickActions";
import { SYNAX_PROFILE_ID } from "./composerTypes";

interface Props {
  projectId: string;
  skillIds: string[];
  onSkillIdsChange: (ids: string[]) => void;
  quickActions?: readonly QuickAction[];
  onQuickActionSelect?: (action: QuickAction, availableSkillIds?: readonly string[]) => void;
  disabled?: boolean;
  skillsDisabled?: boolean;
  subagentsEnabled: boolean;
  onSubagentsEnabledChange: (enabled: boolean) => void;
  onOverlayOpenChange?: (open: boolean) => void;
}

function AttachPanel(props: Props & { open: boolean; close: () => void }) {
  const { t, locale } = useLocale();
  const signedIn = false;
  const quickActions = (props.quickActions ?? []).filter((action) => action.kind === "launch");
  const [skills, setSkills] = useState<SkillSummary[]>([]);
  const [loading, setLoading] = useState(false);
  const loaded = useRef(false);
  useEffect(() => {
    if (props.open && props.disabled) props.close();
  }, [props.open, props.disabled, props.close]);
  useEffect(() => {
    if (!props.open || props.disabled || props.skillsDisabled || loaded.current)
      return;
    let active = true;
    setLoading(true);
    void skillsApi
      .list({ projectId: props.projectId, profileId: SYNAX_PROFILE_ID })
      .then((result) => {
        if (!active) return;
        loaded.current = true;
        setSkills(
          result.items.filter(
            (skill) =>
              skill.status === "available" && Boolean(skill.installPath),
          ),
        );
      })
      .catch(() => {
        if (active) setSkills([]);
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [props.open, props.projectId, props.disabled, props.skillsDisabled]);
  const availableSkillIds = loading || !loaded.current ? undefined : skills.map((item) => item.id);
  return (
    <PopoverPanel
      focus
      anchor={{ to: "top start", gap: 8, padding: 8 }}
      aria-label={t("agentAttach")}
      className="w-72 max-h-[min(36rem,calc(100dvh-24px))] overflow-y-auto"
    >
      <div className="pt-1">
        {!props.skillsDisabled && props.onQuickActionSelect && quickActions.length > 0 && (
          <div className="mb-1 border-b border-border/60 pb-1">
            <h3 className="px-2 py-1 text-[11px] font-medium text-muted-foreground">
              {locale === "zh" ? "快捷操作" : "Quick actions"}
            </h3>
            {quickActions.map((action) => {
              const Icon = action.icon;
              const count = quickActionSkills(action, signedIn)
                .filter((item) => !availableSkillIds || availableSkillIds.includes(item.id)).length;
              const needsInput = action.policy === "compose";
              return (
                <button
                  key={action.id}
                  type="button"
                  disabled={props.disabled}
                  className="flex w-full items-center gap-2 rounded-lg px-2 py-2 text-left text-xs hover:bg-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:cursor-not-allowed disabled:opacity-50"
                  onClick={() => {
                    props.onQuickActionSelect?.(action, availableSkillIds);
                    props.close();
                  }}
                >
                  <span className="flex size-5 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground">
                    <Icon size={12} aria-hidden="true" />
                  </span>
                  <span className="min-w-0 flex-1 truncate">{action.title[locale]}</span>
                  {needsInput && (
                    <span className="shrink-0 rounded-full border border-border px-1.5 py-0.5 text-[9px] text-muted-foreground">
                      {locale === "zh" ? "需补充" : "Needs input"}
                    </span>
                  )}
                  {count > 0 && (
                    <span className="flex shrink-0 items-center gap-0.5 text-[9px] text-muted-foreground">
                      <Sparkles size={9} aria-hidden="true" />{count}
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        )}
        <h3 className="px-2 py-1 text-[11px] font-medium text-muted-foreground">
          {t("agentAttachSkills")}
        </h3>
        {props.skillsDisabled ? (
          <p className="px-2 py-2 text-xs text-muted-foreground">
            {locale === "zh"
              ? "此后端使用原生 Skills 配置。"
              : "This backend uses its native Skills configuration."}
          </p>
        ) : loading ? (
          <p role="status" className="px-2 py-2 text-xs text-muted-foreground">
            {t("agentAttachSkillsLoading")}
          </p>
        ) : skills.length === 0 ? (
          <p className="px-2 py-2 text-xs text-muted-foreground">
            {t("agentAttachSkillsEmpty")}
          </p>
        ) : (
          skills.map((skill) => (
            <Field
              key={skill.id}
              className="!flex items-center gap-2 rounded-lg px-2 py-2 hover:bg-muted"
            >
              <Checkbox
                disabled={props.disabled || props.skillsDisabled}
                checked={props.skillIds.includes(skill.id)}
                onChange={(checked) =>
                  props.onSkillIdsChange(
                    checked
                      ? [...props.skillIds, skill.id]
                      : props.skillIds.filter((id) => id !== skill.id),
                  )
                }
              />
              <Label className="flex min-w-0 flex-1 items-center gap-2 !font-normal">
                <Sparkles size={12} aria-hidden="true" />
                <span className="truncate">{skill.label}</span>
              </Label>
            </Field>
          ))
        )}
        <button
          type="button"
          disabled={props.disabled}
          className="mt-1 flex w-full items-center gap-2 rounded-lg px-2 py-2 text-left text-xs hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
          onClick={() =>
            props.onSubagentsEnabledChange(!props.subagentsEnabled)
          }
        >
          <span
            aria-hidden="true"
            className={`flex size-4 shrink-0 items-center justify-center rounded border ${
              props.subagentsEnabled
                ? "border-primary bg-primary text-primary-foreground"
                : "border-border"
            }`}
          >
            {props.subagentsEnabled && <Check size={11} />}
          </span>
          <span>{t("agentAttachSubagents")}</span>
        </button>
      </div>
    </PopoverPanel>
  );
}

export function ComposerAttachMenu(props: Props) {
  const { t } = useLocale();
  return (
    <Popover>
      {({ open, close }) => (
        <>
          <OverlayStateObserver
            open={open}
            onOpenChange={props.onOverlayOpenChange}
          />
          <Tooltip content={t("agentAttach")}>
            <PopoverButton
              disabled={props.disabled}
              aria-label={t("agentAttach")}
              className="agent-attach-trigger size-7 shrink-0 text-muted-foreground hover:bg-muted"
            >
              <Plus size={15} />
            </PopoverButton>
          </Tooltip>
          <AttachPanel key={props.projectId} {...props} open={open} close={close} />
        </>
      )}
    </Popover>
  );
}
