import {
  Disclosure,
  DisclosureButton,
  DisclosurePanel,
  Radio,
  RadioGroup,
} from "@headlessui/react";
import { useEffect, useMemo, useRef, useState } from "react";
import { BookOpen, Check, ChevronDown, Plus, Sparkles } from "lucide-react";
import {
  Popover,
  PopoverButton,
  PopoverPanel,
} from "@/react/components/ui/Popover";
import { OverlayStateObserver } from "@/react/components/ui/OverlayStateObserver";
import { Field, Label } from "@/react/components/ui/Field";
import { Checkbox, Switch } from "@/react/components/ui/Toggle";
import { Tooltip } from "@/react/components/ui/Tooltip";
import type { WikiDocument } from "../../../../lib/contracts/wiki";
import { skillsApi, type SkillSummary } from "../../../../lib/api/skills";
import { useShellStore } from "../../../state/shellStore";
import { useLocale } from "../../../../hooks/useLocale";
import { SYNAX_PROFILE_ID, type SynaxWikiAttachMode } from "./composerTypes";

interface Props {
  projectId: string;
  documentId: string | null;
  onDocumentChange: (id: string | null) => void;
  wikiAttachMode: SynaxWikiAttachMode;
  onWikiAttachModeChange: (mode: SynaxWikiAttachMode) => void;
  documents: WikiDocument[];
  skillIds: string[];
  onSkillIdsChange: (ids: string[]) => void;
  disabled?: boolean;
  skillsDisabled?: boolean;
  wikiAttachDisabled?: boolean;
  onOverlayOpenChange?: (open: boolean) => void;
}

function WikiAttachPanel({
  documentId,
  onDocumentChange,
  wikiAttachMode,
  onWikiAttachModeChange,
  documents,
  disabled,
}: Pick<
  Props,
  | "documentId"
  | "onDocumentChange"
  | "wikiAttachMode"
  | "onWikiAttachModeChange"
  | "documents"
> & { disabled?: boolean }) {
  const { t } = useLocale();
  const isAuto = wikiAttachMode === "auto";
  const generated = useMemo(
    () =>
      documents.filter(
        (doc) => !doc.isSection && doc.contentMd.trim().length > 0,
      ),
    [documents],
  );
  return (
    <div className="space-y-2 py-2">
      <div className="flex items-center justify-between gap-3 px-2">
        <div>
          <p className="text-xs font-medium">{t("agentWikiAuto")}</p>
          <p className="mt-1 text-[11px] text-muted-foreground">
            {t(isAuto ? "agentWikiAutoOnDesc" : "agentWikiAutoOffDesc")}
          </p>
        </div>
        <Switch
          size="sm"
          checked={isAuto}
          onChange={(checked) =>
            onWikiAttachModeChange(checked ? "auto" : "manual")
          }
          disabled={disabled}
          aria-label={t("agentWikiAuto")}
        />
      </div>
      {!isAuto && (
        <RadioGroup
          value={documentId ?? "__none__"}
          onChange={(value) =>
            onDocumentChange(value === "__none__" ? null : value)
          }
          disabled={disabled}
          aria-label={t("agentWikiContext")}
          className="space-y-1"
        >
          {[{ id: "__none__", title: t("agentWikiNone") }, ...generated].map(
            (doc) => (
              <Radio
                key={doc.id}
                as="button"
                type="button"
                value={doc.id}
                className="group flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-xs data-checked:bg-primary/10 data-checked:text-primary data-disabled:opacity-40 focus-visible:outline-2 focus-visible:outline-ring"
              >
                {({ checked }) => (
                  <>
                    <Check
                      size={13}
                      className={checked ? "shrink-0" : "invisible shrink-0"}
                      aria-hidden="true"
                    />
                    <span className="truncate">{doc.title}</span>
                  </>
                )}
              </Radio>
            ),
          )}
          {generated.length === 0 && (
            <p className="px-2 py-1 text-[11px] text-muted-foreground">
              {t("agentWikiGeneratedEmpty")}
            </p>
          )}
        </RadioGroup>
      )}
    </div>
  );
}

function AttachPanel(props: Props & { open: boolean; close: () => void }) {
  const { t, locale } = useLocale();
  const wikiEnabled = useShellStore((state) => state.preferences.wikiEnabled);
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
  return (
    <PopoverPanel
      focus
      anchor={{ to: "top start", gap: 8, padding: 8 }}
      aria-label={t("agentAttach")}
      className="w-72 max-h-[min(36rem,calc(100dvh-24px))] overflow-y-auto"
    >
      {wikiEnabled && (
        <Disclosure>
          <DisclosureButton
            disabled={props.disabled}
            className="group flex w-full items-center gap-2 rounded-lg px-2 py-2 text-xs hover:bg-muted focus-visible:outline-2 focus-visible:outline-ring"
          >
            <BookOpen size={14} aria-hidden="true" />
            <span>{t("agentAttachWiki")}</span>
            <span className="ml-auto text-[10px] text-muted-foreground">
              {props.wikiAttachMode === "auto"
                ? "AUTO"
                : props.documentId
                  ? "1"
                  : ""}
            </span>
            <ChevronDown
              size={12}
              className="group-data-open:rotate-180"
              aria-hidden="true"
            />
          </DisclosureButton>
          <DisclosurePanel>
            <WikiAttachPanel
              {...props}
              disabled={props.disabled || props.wikiAttachDisabled}
            />
          </DisclosurePanel>
        </Disclosure>
      )}
      <div className="mt-2 border-t border-border pt-2">
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
