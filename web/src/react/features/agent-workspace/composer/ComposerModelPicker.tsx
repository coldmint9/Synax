import { useEffect, useMemo, useState } from "react";
import {
  Combobox,
  ComboboxInput,
  ComboboxOptions,
  ComboboxOption,
} from "@headlessui/react";
import {
  Popover,
  PopoverButton,
  PopoverPanel,
} from "@/react/components/ui/Popover";
import { OverlayStateObserver } from "@/react/components/ui/OverlayStateObserver";
import type {
  GlobalConfig,
  ProviderDef,
} from "../../../../lib/contracts/config";
import type { ModelCapability } from "../../../../lib/contracts/media-generation";
import { useLocale } from "../../../../hooks/useLocale";
import {
  buildAgentModelOptions,
  findAgentModelSelection,
  selectionKey,
  type AgentModelSelection,
} from "./modelSelection";
import { useAcpDiscovery } from "./useAcpDiscovery";

interface Props {
  backendId?: string;
  globalConfig: GlobalConfig | null;
  providers: ProviderDef[];
  providerId: string | null;
  modelId: string | null;
  capability?: ModelCapability;
  onSelect: (selection: AgentModelSelection) => void;
  disabled?: boolean;
  onOverlayOpenChange?: (open: boolean) => void;
}

function matchesQuery(
  option: AgentModelSelection,
  query: string,
  providerLabel: string,
): boolean {
  if (!query) return true;
  return (
    option.label.toLowerCase().includes(query) ||
    providerLabel.toLowerCase().includes(query) ||
    option.capability.toLowerCase().includes(query)
  );
}

export function ComposerModelPicker(props: Props) {
  return (
    <Popover>
      {({ open, close }) => (
        <ModelPickerContent {...props} open={open} close={close} />
      )}
    </Popover>
  );
}

function ModelPickerContent({
  backendId,
  globalConfig,
  providers,
  providerId,
  modelId,
  capability,
  onSelect,
  disabled,
  onOverlayOpenChange,
  open,
  close,
}: Props & { open: boolean; close: () => void }) {
  const { t } = useLocale();
  useEffect(() => {
    if (disabled && open) close();
  }, [disabled, open, close]);
  const [searchQuery, setSearchQuery] = useState("");
  // Only probe ACP when the picker opens — keep session select off the critical path.
  const acpDiscovery = useAcpDiscovery({ enabled: open });
  useEffect(() => {
    if (!open) setSearchQuery("");
  }, [open]);

  const { apiModels, acpEndpoints } = useMemo(() => {
    const options = buildAgentModelOptions(
      globalConfig,
      providers,
      acpDiscovery,
    );
    if (!backendId) return options;
    return {
      apiModels: backendId === "native" ? options.apiModels : [],
      acpEndpoints: options.acpEndpoints.filter(
        (option) => option.providerId === backendId,
      ),
    };
  }, [globalConfig, providers, acpDiscovery, backendId]);

  const allOptions = useMemo(
    () => [...apiModels, ...acpEndpoints],
    [apiModels, acpEndpoints],
  );

  const selected = useMemo(
    () => findAgentModelSelection(apiModels, acpEndpoints, providerId, modelId, capability),
    [apiModels, acpEndpoints, providerId, modelId, capability],
  );

  const selectedProviderLabel = providerId
    ? (providers.find((provider) => provider.id === providerId)?.label ??
      providerId)
    : null;
  const selectedModelLabel = selected?.label ?? modelId;
  const selectedCapabilityLabel = selected?.capability === "image_generation"
    ? "生图"
    : selected?.capability === "video_generation"
      ? "生视频"
      : "对话";
  const triggerLabel =
    selectedProviderLabel && selectedModelLabel
      ? `${selectedProviderLabel} · ${selectedModelLabel} · ${selectedCapabilityLabel}`
      : (selectedModelLabel ?? t("agentModelSelect"));

  const query = searchQuery.trim().toLowerCase();
  const groups = useMemo(() => {
    const labels = new Map(
      providers.map((provider) => [provider.id, provider.label]),
    );
    const grouped = new Map<
      string,
      { label: string; options: AgentModelSelection[] }
    >();
    for (const option of allOptions) {
      const label = labels.get(option.providerId) || option.providerId;
      if (!matchesQuery(option, query, label)) continue;
      let group = grouped.get(option.providerId);
      if (!group) {
        group = { label, options: [] };
        grouped.set(option.providerId, group);
      }
      group.options.push(option);
    }
    return Array.from(grouped, ([id, group]) => ({ id, ...group }));
  }, [allOptions, providers, query]);

  function handlePick(option: AgentModelSelection) {
    onSelect(option);
    setSearchQuery("");
    close();
  }

  const triggerDisabled = Boolean(disabled);

  return (
    <>
      <OverlayStateObserver open={open} onOpenChange={onOverlayOpenChange} />
      <PopoverButton
        aria-label={t("agentModelSelect")}
        disabled={triggerDisabled}
        title={triggerLabel}
        className={`button button--sm button--tertiary agent-dock-composer-chip agent-model-picker-trigger inline-flex h-7 max-w-[18rem] shrink-0 items-center rounded-full px-2.5 text-[11px] font-normal text-muted-foreground${triggerDisabled ? " pointer-events-none opacity-50" : ""}`}
      >
        <span className="truncate">{triggerLabel}</span>
      </PopoverButton>
      <PopoverPanel
        onKeyDownCapture={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            close();
          }
        }}
        focus
        anchor={{ to: "top end", gap: 8, padding: 8 }}
        className="z-50 w-[20rem] overflow-hidden p-0"
      >
        <Combobox
          value={selected ?? null}
          by={(a, b) =>
            a === b || Boolean(a && b && selectionKey(a) === selectionKey(b))
          }
          onChange={(option) => {
            if (option) handlePick(option);
          }}
          immediate
          disabled={disabled}
        >
          <div className="border-b border-border/30 p-1.5">
            <ComboboxInput
              autoFocus
              aria-label={t("agentModelSearch")}
              displayValue={() => searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder={t("agentModelSearch")}
              className="h-7 w-full rounded-item bg-muted/40 px-2 text-[11px] outline-none placeholder:text-muted-foreground/50"
            />
          </div>
          <ComboboxOptions
            modal={false}
            static
            aria-label={t("agentModelSelect")}
            className="max-h-64 overflow-y-auto p-1.5"
          >
            {groups.map((group) => (
              <div
                key={group.id}
                role="group"
                aria-label={group.label}
                className="mb-1 last:mb-0"
              >
                <div className="px-2.5 pb-1 pt-2 text-[10px] font-medium text-muted-foreground">
                  {group.label}
                </div>
                {group.options.map((option) => (
                  <ComboboxOption
                    key={selectionKey(option)}
                    value={option}
                    className="flex w-full cursor-default items-center gap-2 rounded-item px-2.5 py-1.5 text-left text-foreground/80 outline-none transition-colors data-focus:bg-secondary/60 data-selected:bg-primary/10 data-selected:text-primary"
                  >
                    <span className="min-w-0 flex-1 truncate text-[11px] font-medium">
                      {option.label}
                    </span>
                    <span className="shrink-0 text-[10px] text-muted-foreground">
                      {option.capability === "image_generation"
                        ? "生图"
                        : option.capability === "video_generation"
                          ? "生视频"
                          : "对话"}
                    </span>
                  </ComboboxOption>
                ))}
              </div>
            ))}
            {groups.length === 0 && (
              <p className="px-2 py-3 text-center text-[10px] text-muted-foreground/50">
                {query ? t("agentModelNoMatch") : t("agentModelEmpty")}
              </p>
            )}
          </ComboboxOptions>
        </Combobox>
      </PopoverPanel>
    </>
  );
}
