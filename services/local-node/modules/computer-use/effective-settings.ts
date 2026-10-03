import { getGlobalConfig } from "../../infrastructure/runtime/config/config-store.js";
import { getProjectSettings } from "../../infrastructure/runtime/config/project-settings-store.js";
import {
  mergeComputerUseSettings,
  type ComputerUseSettings,
} from "./strategy.js";

/** Global defaults provide every value a project did not explicitly override. */
function globalComputerUseSettings(): ComputerUseSettings | undefined {
  const settings = getGlobalConfig().computerUse;
  if (!settings) return undefined;
  const jev = settings.jev;
  return {
    enabled: settings.enabled !== false,
    strategy: settings.strategy ?? "auto",
    perception: settings.perception ?? "disabled",
    ...(jev
      ? {
          jev: {
            enabled: jev.enabled === true,
            fallback: jev.fallback ?? "fail_closed",
            providerId: jev.providerId ?? undefined,
            model: jev.model ?? undefined,
          },
        }
      : {}),
  };
}

export function resolveEffectiveComputerUseSettings(
  projectId: string,
): ComputerUseSettings {
  return mergeComputerUseSettings(
    globalComputerUseSettings(),
    getProjectSettings(projectId).computerUse,
  );
}
